"""DigInside System mode: launch a command, sample /proc, parse strace, yield ticks.

Usage:
    run = SystemRun("./a.out 4", use_strace=True, interval=0.05)
    async for msg in run.ticks():   # {"type": "start"} , {"type": "tick"}..., {"type": "exit"}
        ...
    run.stop()                      # from anywhere: kills the process group

Data sources (all per thread = /proc/<pid>/task/<tid>/...):
    stat       state, utime/stime (clock ticks), minflt/majflt, processor (last CPU, field 39)
    status     voluntary_ctxt_switches / nonvoluntary_ctxt_switches
    schedstat  on-CPU ns, runqueue-wait ns, timeslices  (ns precision, unlike utime)
    children   child PIDs, used to walk the process tree
System-wide: /proc/stat per-CPU jiffies -> per-core user/kernel busy fraction.
Syscalls: strace -f -ttt -T writing to a FIFO, parsed in a reader thread.
"""
from __future__ import annotations

import asyncio
import os
import pty
import re
import shlex
import signal
import subprocess
import tempfile
import threading
import time
from collections import Counter, deque
from typing import AsyncIterator

CLK_TCK = os.sysconf("SC_CLK_TCK")
TICK_MS = 1000.0 / CLK_TCK

RECENT_SYSCALLS_PER_TICK = 40   # detailed syscall lines sent per tick (all are still counted)
OUTPUT_LINES_PER_TICK = 100
OUTPUT_LINE_MAX = 300
ARGS_MAX = 100


# --------------------------------------------------------------------------- /proc readers

def _read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read()
    except OSError:  # vanished (thread exited), permission, ESRCH...
        return None


def read_thread(pid: int, tid: int) -> dict | None:
    base = f"/proc/{pid}/task/{tid}"
    stat = _read(f"{base}/stat")
    if stat is None:
        return None
    lp, rp = stat.find("("), stat.rfind(")")
    comm = stat[lp + 1 : rp]
    f = stat[rp + 2 :].split()  # f[0] is field 3 (state); field n -> f[n - 3]
    t = {
        "pid": pid,
        "tid": tid,
        "comm": comm,
        "state": f[0],
        "minflt": int(f[7]),
        "majflt": int(f[9]),
        "utime_ms": int(f[11]) * TICK_MS,
        "stime_ms": int(f[12]) * TICK_MS,
        "cpu": int(f[36]),
        "vcs": 0,
        "nvcs": 0,
        "run_ns": 0,
        "wait_ns": 0,
        "allowed": "",
    }
    status = _read(f"{base}/status")
    if status:
        for line in status.splitlines():
            if line.startswith("voluntary_ctxt_switches"):
                t["vcs"] = int(line.split()[1])
            elif line.startswith("nonvoluntary_ctxt_switches"):
                t["nvcs"] = int(line.split()[1])
            elif line.startswith("Cpus_allowed_list"):
                t["allowed"] = line.split(":", 1)[1].strip()
    ss = _read(f"{base}/schedstat")
    if ss:
        parts = ss.split()
        if len(parts) >= 2:
            t["run_ns"], t["wait_ns"] = int(parts[0]), int(parts[1])
    return t


def list_tids(pid: int) -> list[int]:
    try:
        return sorted(int(x) for x in os.listdir(f"/proc/{pid}/task"))
    except OSError:
        return []


def child_pids(pid: int) -> list[int]:
    out: list[int] = []
    for tid in list_tids(pid):
        s = _read(f"/proc/{pid}/task/{tid}/children")
        if s:
            out.extend(int(x) for x in s.split())
    return out


def process_tree(roots: list[int]) -> list[int]:
    seen: list[int] = []
    stack = list(roots)
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.append(p)
        stack.extend(child_pids(p))
    return sorted(seen)


def cpu_jiffies() -> dict[int, tuple[int, int, int]]:
    """cpu id -> (user, kernel, total) jiffies from /proc/stat."""
    out = {}
    s = _read("/proc/stat") or ""
    for line in s.splitlines():
        if line.startswith("cpu") and line[3:4].isdigit():
            name, *vals = line.split()
            v = [int(x) for x in vals[:8]] + [0] * (8 - len(vals[:8]))
            user, nice, system, idle, iowait, irq, softirq, steal = v
            out[int(name[3:])] = (user + nice, system + irq + softirq, sum(v))
    return out


# --------------------------------------------------------------------------- strace parsing

_LINE = re.compile(r"^(?:(\d+)\s+)?(\d+\.\d+)\s+(.*)$")
_DONE = re.compile(r"^(\w+)\((.*)\)\s+=\s+(\S+)(.*)$")
_RESUMED = re.compile(r"^<\.\.\. (\w+) resumed>(.*?)\)?\s+=\s+(\S+)(.*)$")
_UNFINISHED = re.compile(r"^(\w+)\((.*?)\s*<unfinished \.\.\.>$")
_SIGNAL = re.compile(r"^--- (SIG\w+)")
_EXITED = re.compile(r"^\+\+\+ (.*) \+\+\+$")
_ERRNO = re.compile(r"^\s*([A-Z][A-Z0-9_]+)\b")
_DUR = re.compile(r"<(\d+\.\d+)>\s*$")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB012]")  # terminal colour/cursor codes


class StraceReader:
    """Reads strace output from a FIFO in a thread and aggregates it.

    Per tick (drained by the sampler): counts/time/errors by syscall name, counts by tid,
    and up to RECENT_SYSCALLS_PER_TICK detailed records. Running totals are kept for the summary.
    """

    def __init__(self, fifo: str, t0_wall: float):
        self.fifo = fifo
        self.t0 = t0_wall
        self.lock = threading.Lock()
        self.pending: dict[int, tuple[str, str]] = {}  # tid -> (name, args) for <unfinished>
        self._reset_tick()
        self.total_count: Counter = Counter()
        self.total_time: Counter = Counter()
        self.total_err: Counter = Counter()
        self.unparsed = 0
        self.thread = threading.Thread(target=self._run, daemon=True)
        self._opened = threading.Event()

    def _reset_tick(self):
        self.t_count: Counter = Counter()
        self.t_time: Counter = Counter()
        self.t_err: Counter = Counter()
        self.t_by_tid: Counter = Counter()
        self.t_recent: deque = deque(maxlen=RECENT_SYSCALLS_PER_TICK)
        self.t_dropped = 0

    def start(self):
        self.thread.start()

    def _run(self):
        with open(self.fifo, errors="replace") as f:
            self._opened.set()
            for line in f:
                self._handle(line.rstrip("\n"))

    def close(self, timeout: float = 2.0):
        # If strace never opened the FIFO, the reader is stuck in open(); give it an EOF.
        if not self._opened.is_set():
            try:
                fd = os.open(self.fifo, os.O_WRONLY | os.O_NONBLOCK)
                os.close(fd)
            except OSError:
                pass
        self.thread.join(timeout)

    def _complete(self, tid: int, ts: float, name: str, args: str, ret: str, tail: str):
        m = _DUR.search(tail)
        dur = float(m.group(1)) if m else 0.0
        err = None
        if ret.startswith("-"):
            em = _ERRNO.match(tail)
            err = em.group(1) if em else ret
        rec = {
            "tid": tid,
            "t": round(ts - self.t0, 6),
            "name": name,
            "args": args if len(args) <= ARGS_MAX else args[:ARGS_MAX] + "…",
            "ret": ret,
            "err": err,
            "dur_us": round(dur * 1e6, 1),
        }
        with self.lock:
            self.t_count[name] += 1
            self.t_time[name] += dur
            self.t_by_tid[tid] += 1
            self.total_count[name] += 1
            self.total_time[name] += dur
            if err:
                self.t_err[name] += 1
                self.total_err[name] += 1
            if len(self.t_recent) == self.t_recent.maxlen:
                self.t_dropped += 1
            self.t_recent.append(rec)

    def _event(self, tid: int, ts: float, kind: str, text: str):
        rec = {"tid": tid, "t": round(ts - self.t0, 6), "name": kind, "args": text,
               "ret": "", "err": None, "dur_us": 0.0}
        with self.lock:
            self.t_recent.append(rec)

    def _handle(self, line: str):
        m = _LINE.match(line)
        if not m:
            self.unparsed += 1
            return
        tid = int(m.group(1) or 0)
        ts = float(m.group(2))
        rest = m.group(3)
        if (d := _UNFINISHED.match(rest)):
            self.pending[tid] = (d.group(1), d.group(2))
        elif (d := _RESUMED.match(rest)):
            name = d.group(1)
            first = self.pending.pop(tid, (name, ""))[1]
            self._complete(tid, ts, name, first + d.group(2), d.group(3), d.group(4))
        elif (d := _DONE.match(rest)):
            self._complete(tid, ts, d.group(1), d.group(2), d.group(3), d.group(4))
        elif (d := _SIGNAL.match(rest)):
            self._event(tid, ts, "signal", d.group(1))
        elif (d := _EXITED.match(rest)):
            self._event(tid, ts, "exit", d.group(1))
        else:
            self.unparsed += 1

    def drain(self) -> dict:
        with self.lock:
            out = {
                "count": sum(self.t_count.values()),
                "by_name": {k: {"n": n, "time_us": round(self.t_time[k] * 1e6, 1),
                                "err": self.t_err.get(k, 0)}
                            for k, n in self.t_count.most_common()},
                "by_tid": {str(k): v for k, v in self.t_by_tid.items()},
                "recent": list(self.t_recent),
                "dropped": self.t_dropped,
            }
            self._reset_tick()
        return out

    def summary(self) -> list[dict]:
        with self.lock:
            return [{"name": k, "n": n, "time_us": round(self.total_time[k] * 1e6, 1),
                     "err": self.total_err.get(k, 0)}
                    for k, n in self.total_count.most_common()]


# --------------------------------------------------------------------------- output capture

class OutputReader:
    """Reads the program's terminal output (stdout+stderr on a pty, so it stays line-buffered)."""

    def __init__(self, master_fd: int):
        self.fd = master_fd
        self.lock = threading.Lock()
        self.lines: list[str] = []
        self.dropped = 0
        self._buf = b""
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def _push(self, raw: bytes):
        s = _ANSI.sub("", raw.decode(errors="replace")).rstrip("\r")
        if len(s) > OUTPUT_LINE_MAX:
            s = s[:OUTPUT_LINE_MAX] + "…"
        with self.lock:
            if len(self.lines) >= OUTPUT_LINES_PER_TICK:
                self.dropped += 1
            else:
                self.lines.append(s)

    def _run(self):
        while True:
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:  # EIO once every writer of the pty slave has exited
                break
            if not chunk:
                break
            self._buf += chunk
            *full, self._buf = self._buf.split(b"\n")
            for line in full:
                self._push(line)
        if self._buf:
            self._push(self._buf)
        try:
            os.close(self.fd)
        except OSError:
            pass

    def drain(self) -> dict:
        with self.lock:
            out = {"lines": self.lines, "dropped": self.dropped}
            self.lines, self.dropped = [], 0
        return out


# --------------------------------------------------------------------------- the run

def all_cpus() -> list[int]:
    return sorted(os.sched_getaffinity(0))


def normalize_cpus(cpus) -> list[int] | None:
    """None/[] -> None (no pinning); otherwise a sorted list of valid CPU ids."""
    if not cpus:
        return None
    valid = set(all_cpus())
    out = sorted({int(c) for c in cpus} & valid)
    if not out:
        raise ValueError(f"no valid CPUs in {cpus!r}")
    return out


class SystemRun:
    def __init__(self, cmd: str | None = None, use_strace: bool = True, interval: float = 0.05,
                 cwd: str | None = None, max_seconds: float = 300.0,
                 argv: list[str] | None = None, cpus: list[int] | None = None):
        self.argv = list(argv) if argv else shlex.split(cmd or "")
        if not self.argv:
            raise ValueError("empty command")
        self.cmd = cmd or shlex.join(self.argv)
        self.cpus = normalize_cpus(cpus)
        self._tree: list[int] = []
        self.use_strace = use_strace
        self.interval = max(0.01, interval)
        self.cwd = cwd
        self.max_seconds = max_seconds
        self.proc: subprocess.Popen | None = None
        self._stopped = False

    def set_affinity(self, cpus) -> list[int] | None:
        """Re-pin every thread of the running program (None/[] = allow all CPUs)."""
        self.cpus = normalize_cpus(cpus)
        target = set(self.cpus or all_cpus())
        for pid in self._tree:
            for tid in list_tids(pid):
                try:
                    os.sched_setaffinity(tid, target)
                except OSError:
                    pass
        return self.cpus

    def stop(self):
        self._stopped = True
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    async def ticks(self) -> AsyncIterator[dict]:
        tmpdir = tempfile.mkdtemp(prefix="diginside-")
        fifo = os.path.join(tmpdir, "strace.fifo")
        strace = None
        master, slave = pty.openpty()
        out = OutputReader(master)
        try:
            # Pin with taskset *inside* strace so strace itself stays free to run on any core;
            # taskset sets the affinity and execs the program, which all its threads/children inherit.
            prog = (["taskset", "-c", ",".join(map(str, self.cpus))] if self.cpus else []) + self.argv
            if self.use_strace:
                os.mkfifo(fifo)
                full = ["strace", "-f", "-qq", "-ttt", "-T", "-s", "32", "-o", fifo, "--", *prog]
                strace = StraceReader(fifo, time.time())
                strace.start()
            else:
                full = prog
            t0 = time.monotonic()
            try:
                # Plain subprocess.Popen, not asyncio's: under uvicorn's uvloop event loop,
                # create_subprocess_exec ignores close_fds and the program inherits the server's
                # sockets/pipes (it would see e.g. fd 3 = the HTTP socket). Popen closes them.
                self.proc = subprocess.Popen(
                    full, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave,
                    cwd=self.cwd, start_new_session=True, close_fds=True)
            except OSError as e:
                os.close(master)
                yield {"type": "error", "message": f"failed to launch {self.argv[0]!r}: {e}"}
                return
            finally:
                os.close(slave)  # child holds its own copy; master gets EIO when it exits
            out.start()
            wait_task = asyncio.get_running_loop().run_in_executor(None, self.proc.wait)

            yield {"type": "start", "cmd": self.cmd, "argv": self.argv, "launcher_pid": self.proc.pid, "cpus": self.cpus,
                   "strace": self.use_strace, "interval_ms": self.interval * 1000,
                   "nproc": len(os.sched_getaffinity(0)), "clk_tck": CLK_TCK}

            prev_threads: dict[int, dict] = {}
            last_seen: dict[int, dict] = {}
            prev_cpu = cpu_jiffies()
            prev_t = t0
            next_deadline = t0
            seq = 0
            while True:
                next_deadline += self.interval
                await asyncio.sleep(max(0.0, next_deadline - time.monotonic()))
                finished = wait_task.done()
                now = time.monotonic()
                dt = now - prev_t
                prev_t = now
                if now - t0 > self.max_seconds and not finished:
                    self.stop()

                # Under strace, the program is strace's child; otherwise it is ours.
                roots = child_pids(self.proc.pid) if self.use_strace else [self.proc.pid]
                threads = []
                self._tree = process_tree(roots)
                for pid in self._tree:
                    for tid in list_tids(pid):
                        t = read_thread(pid, tid)
                        if t is None:
                            continue
                        p = prev_threads.get(tid)
                        if p:
                            t["migrated"] = t["cpu"] != p["cpu"]
                            t["d_utime_ms"] = t["utime_ms"] - p["utime_ms"]
                            t["d_stime_ms"] = t["stime_ms"] - p["stime_ms"]
                            t["d_vcs"] = t["vcs"] - p["vcs"]
                            t["d_nvcs"] = t["nvcs"] - p["nvcs"]
                            t["d_minflt"] = t["minflt"] - p["minflt"]
                            d_run = t["run_ns"] - p["run_ns"]
                            d_wait = t["wait_ns"] - p["wait_ns"]
                        else:
                            t["migrated"] = False
                            t["d_utime_ms"], t["d_stime_ms"] = t["utime_ms"], t["stime_ms"]
                            t["d_vcs"], t["d_nvcs"], t["d_minflt"] = t["vcs"], t["nvcs"], t["minflt"]
                            d_run, d_wait = t["run_ns"], t["wait_ns"]
                        # ns on a CPU since the last sample (from schedstat), credited to t["cpu"] by the UI
                        t["d_run_ms"] = round(d_run / 1e6, 3)
                        # fraction of this tick the thread spent on a CPU / waiting in a runqueue
                        t["oncpu"] = round(min(1.0, d_run / (dt * 1e9)), 3) if dt > 0 else 0.0
                        t["runq"] = round(min(1.0, d_wait / (dt * 1e9)), 3) if dt > 0 else 0.0
                        threads.append(t)
                prev_threads = {t["tid"]: t for t in threads}
                for t in threads:
                    last_seen[t["tid"]] = t

                cpu = cpu_jiffies()
                cores = []
                for c, (u, k, tot) in sorted(cpu.items()):
                    pu, pk, ptot = prev_cpu.get(c, (u, k, tot))
                    d = tot - ptot
                    cores.append({"cpu": c,
                                  "user": round((u - pu) / d, 3) if d > 0 else 0.0,
                                  "kernel": round((k - pk) / d, 3) if d > 0 else 0.0})
                prev_cpu = cpu

                yield {"type": "tick", "seq": seq, "t": round(now - t0, 4), "dt": round(dt, 4),
                       "threads": [_public(t) for t in threads], "cores": cores,
                       "syscalls": strace.drain() if strace else None,
                       "output": out.drain()}
                seq += 1
                if finished:
                    break

            code = self.proc.returncode
            out.thread.join(1.0)
            if strace:
                strace.close()
            yield {"type": "exit", "code": code, "killed": self._stopped,
                   "signal": signal.Signals(-code).name if code is not None and code < 0 else None,
                   "wall_s": round(time.monotonic() - t0, 4),
                   "output": out.drain(),
                   "threads": [_public(t) for t in last_seen.values()],
                   "user_ms": round(sum(t["utime_ms"] for t in last_seen.values()), 1),
                   "kernel_ms": round(sum(t["stime_ms"] for t in last_seen.values()), 1),
                   "syscalls": strace.summary() if strace else None,
                   "strace_unparsed": strace.unparsed if strace else 0}
        finally:
            self.stop()
            if strace:
                strace.close(timeout=0.5)
            try:
                os.remove(fifo)
            except OSError:
                pass
            try:
                os.rmdir(tmpdir)
            except OSError:
                pass


_PUBLIC_KEYS = ("pid", "tid", "comm", "state", "cpu", "migrated", "oncpu", "runq",
                "utime_ms", "stime_ms", "d_utime_ms", "d_stime_ms",
                "vcs", "nvcs", "d_vcs", "d_nvcs", "minflt", "majflt", "d_minflt", "allowed", "d_run_ms")


def _public(t: dict) -> dict:
    return {k: t[k] for k in _PUBLIC_KEYS if k in t}
