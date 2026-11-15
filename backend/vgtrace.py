"""DigInside: trace the real machine code's memory accesses with Valgrind (lackey).

Any C/C++ program, no tarray needed. Pipeline:
  1. build with the program's build command plus `-g -no-pie` (debug info for source lines; fixed
     addresses for globals, so traces are repeatable)
  2. run under `valgrind --tool=lackey --trace-mem=yes` with heapshim.so preloaded, which logs every
     malloc/calloc/realloc so heap blocks can be labeled
  3. keep, by default, only accesses made by the program's own code: lackey prints each instruction
     (`I addr,size`) before the loads/stores it makes (` L`, ` S`, ` M` = load+store), so accesses whose
     instruction lies outside the executable's .text (dynamic loader, libc, printf internals) or in C
     runtime startup functions are dropped
  4. label addresses: global symbols (nm), heap blocks (heap log), the stack
  5. map each instruction to file:line with addr2line, so every access shows the source line that made it
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path

import workspace
from cache_sim import Trace

INSTRUMENT = Path(__file__).resolve().parent.parent / "instrument"
SHIM_SRC = INSTRUMENT / "heapshim.c"
SHIM_SO = INSTRUMENT / ".build" / "heapshim.so"
RUN_TIMEOUT_S = 60
STARTUP_FUNCS = {
    "_start", "_dl_relocate_static_pie", "deregister_tm_clones", "register_tm_clones",
    "__do_global_dtors_aux", "frame_dummy", "_init", "_fini", "__libc_csu_init", "__libc_csu_fini",
}
STACK_FLOOR = 0x1000000000  # Valgrind puts the client stack near 0x1ffefff000; heap/globals sit far below


class VgError(ValueError):
    pass


def available() -> bool:
    try:
        return subprocess.run(["valgrind", "--version"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _shim() -> str:
    if not SHIM_SO.exists() or SHIM_SO.stat().st_mtime < SHIM_SRC.stat().st_mtime:
        SHIM_SO.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["gcc", "-O2", "-shared", "-fPIC", str(SHIM_SRC), "-o", str(SHIM_SO)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise VgError(f"could not build heapshim: {r.stderr.strip()}")
    return str(SHIM_SO)


def _text_range(exe: str) -> tuple[int, int]:
    out = subprocess.run(["readelf", "-SW", exe], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if " .text " in line:
            p = line.split()
            i = p.index(".text")
            addr, size = int(p[i + 2], 16), int(p[i + 4], 16)
            return addr, addr + size
    raise VgError("no .text section in the executable")


def _data_sections(exe: str) -> list[tuple[int, int, str]]:
    """(base, size, name) of allocated, non-executable sections (.rodata, .data, .bss, .got, ...)."""
    out = subprocess.run(["readelf", "-SW", exe], capture_output=True, text=True).stdout
    secs = []
    for line in out.splitlines():
        m = re.match(r"\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+(\S*)", line)
        if not m:
            continue
        name, addr, size, flags = m.group(1), int(m.group(2), 16), int(m.group(3), 16), m.group(4)
        if addr and size and "A" in flags and "X" not in flags:
            secs.append((addr, size, name))
    return sorted(secs)


def _data_symbols(exe: str) -> list[tuple[int, int, str]]:
    """(base, size, name) of global/static data objects, demangled."""
    out = subprocess.run(["nm", "-S", "-C", "--defined-only", exe], capture_output=True, text=True).stdout
    syms = []
    for line in out.splitlines():
        p = line.split(maxsplit=3)
        if len(p) == 4 and p[2] in "bBdDrRgGsS" and len(p[2]) == 1:
            size = int(p[1], 16)
            if size > 0:
                syms.append((int(p[0], 16), size, p[3]))
    return sorted(syms)


def _addr2line(exe: str, ips: list[int], prefer: str) -> dict[int, tuple[str, int, str]]:
    """ip -> (file, line, function). With inlining, prefer the frame in the user's source file."""
    if not ips:
        return {}
    r = subprocess.run(["addr2line", "-a", "-f", "-C", "-i", "-e", exe], input="\n".join(hex(i) for i in ips),
                       capture_output=True, text=True, timeout=60)
    res: dict[int, tuple[str, int, str]] = {}
    cur, frames = None, []

    def flush():
        if cur is None:
            return
        pick = next((f for f in frames if os.path.basename(f[0]) == prefer), frames[0] if frames else ("??", 0, "??"))
        res[cur] = pick

    lines = r.stdout.splitlines()
    i = 0
    while i < len(lines):
        l = lines[i]
        if l.startswith("0x"):
            flush()
            cur, frames = int(l, 16), []
            i += 1
            continue
        func = l
        loc = lines[i + 1] if i + 1 < len(lines) else "??:0"
        file, _, ln = loc.rpartition(":")
        m = re.match(r"\d+", ln)
        frames.append((file, int(m.group()) if m else 0, func))
        i += 2
    flush()
    return res


def trace(rel: str, argv_args: list[str], scope: str, max_accesses: int, build_template: str | None) -> dict:
    """Build + run under Valgrind; returns {"build", "run", "trace": Trace} (trace None on failure)."""
    src = workspace.resolve(rel)
    lang = workspace.LANGS[src.suffix.lower()]
    if lang not in ("c", "cpp") or src.suffix.lower() not in workspace.RUNNABLE:
        raise VgError("Valgrind tracing needs a C or C++ program")
    if not available():
        raise VgError("valgrind is not installed (sudo apt install valgrind)")

    template = (build_template or workspace.DEFAULT_BUILD[lang]).replace("-fopenmp", "")
    for flag in ("-g", "-no-pie"):  # debug info for source lines; fixed addresses for repeatable traces
        if flag not in shlex.split(template):
            template += " " + flag
    import asyncio  # build() is async; we're already in a worker thread
    b = asyncio.run(workspace.build(rel, template))
    if not b["ok"]:
        return {"build": b, "run": None, "trace": None}
    exe = b["argv"][0]

    with tempfile.TemporaryDirectory(prefix="diginside-vg-") as tmp:
        log, heaplog = os.path.join(tmp, "lackey.txt"), os.path.join(tmp, "heap.txt")
        env = {**os.environ, "LD_PRELOAD": _shim(), "DIGINSIDE_HEAPLOG": heaplog}
        cmd = ["valgrind", "--tool=lackey", "--trace-mem=yes", f"--log-file={log}", exe, *argv_args]
        try:
            p = subprocess.run(cmd, env=env, cwd=str(workspace.WORKSPACE), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=RUN_TIMEOUT_S, close_fds=True)
            code, out = p.returncode, p.stdout.decode(errors="replace")
        except subprocess.TimeoutExpired:
            raise VgError(f"the program ran longer than {RUN_TIMEOUT_S} s under Valgrind (it is ~50x slower); "
                          "try smaller arguments")
        run = {"code": code, "output": "\n".join(out.splitlines()[:200]), "ms": 0, "cached": False,
               "cmd": "valgrind --tool=lackey --trace-mem=yes " + shlex.join([os.path.basename(exe), *argv_args])}

        lo, hi = _text_range(exe)
        ops: list[int] = []
        addrs: list[int] = []
        sizes: list[int] = []
        ipl: list[int] = []
        total = kept_outside = 0
        truncated = False
        ip = 0
        with open(log, errors="replace") as f:
            for line in f:
                c0 = line[:1]
                if c0 == "I":
                    ip = int(line[3:line.index(",")], 16)
                    continue
                if c0 != " ":
                    continue
                kind = line[1:2]
                if kind not in ("L", "S", "M"):
                    continue
                total += 1
                if scope == "code" and not (lo <= ip < hi):
                    continue
                if len(ops) >= max_accesses:
                    truncated = True
                    continue
                a, _, sz = line[3:].strip().partition(",")
                addr, size = int(a, 16), int(sz or 1)
                if kind == "M":  # read-modify-write: one load and one store
                    ops += [0, 1]; addrs += [addr, addr]; sizes += [size, size]; ipl += [ip, ip]
                else:
                    ops.append(1 if kind == "S" else 0); addrs.append(addr); sizes.append(size); ipl.append(ip)
        heap = []
        try:
            with open(heaplog) as f:
                for line in f:
                    p_ = line.split()
                    if len(p_) == 3:
                        heap.append((int(p_[1], 16), int(p_[2])))
        except FileNotFoundError:
            pass

    # source lines for every instruction that made a kept access
    uniq = sorted(set(ipl))
    where = _addr2line(exe, uniq, src.name)
    if scope == "code":
        keep = [i for i in range(len(ops)) if where.get(ipl[i], ("", 0, ""))[2] not in STARTUP_FUNCS]
        ops = [ops[i] for i in keep]; addrs = [addrs[i] for i in keep]; sizes = [sizes[i] for i in keep]; ipl = [ipl[i] for i in keep]

    src_text = src.read_text(errors="replace").splitlines()
    line_index: dict[tuple, int] = {}
    lines_tab: list[dict] = []
    line_ids: list[int] = []
    for ip_ in ipl:
        file, ln, func = where.get(ip_, ("??", 0, "??"))
        key = (file, ln, func)
        if key not in line_index:
            text = src_text[ln - 1].strip() if os.path.basename(file) == src.name and 0 < ln <= len(src_text) else ""
            line_index[key] = len(lines_tab)
            lines_tab.append({"file": os.path.basename(file), "line": ln, "func": func, "text": text})
        line_ids.append(line_index[key])

    # name the memory: globals from the symbol table, heap blocks from the heap log, then the stack
    syms = _data_symbols(exe)
    secs = _data_sections(exe)
    regions: list[dict] = []
    seen_region: dict[tuple, int] = {}
    min_size: dict[tuple, int] = {}
    span: dict[int, list[int]] = {}  # region index -> [lowest, highest+size) actually accessed
    stack_lo = stack_hi = None
    heap_n = 0
    for a, sz in zip(addrs, sizes):
        key = None
        for base, size, name in syms:
            if base <= a < base + size:
                key = ("global", name, base, size)
                break
        if key is None and a < STACK_FLOOR:
            for hb, hs in reversed(heap):  # latest allocation covering the address
                if hb <= a < hb + max(hs, 1):
                    key = ("heap", hb, hb, hs)
                    break
        if key is None and a < STACK_FLOOR:
            for base, size, name in secs:  # unnamed data inside the executable, e.g. constants in .rodata
                if base <= a < base + size:
                    key = ("section", name, base, size)
                    break
        if key is None and a < STACK_FLOOR:  # outside the program: thread-local storage, libraries, ...
            page = a & ~0xFFF
            key = ("other", "other", page, 0x1000)
        if key is None:
            if a >= STACK_FLOOR:
                stack_lo = a if stack_lo is None else min(stack_lo, a)
                stack_hi = a + sz if stack_hi is None else max(stack_hi, a + sz)
            continue
        if key not in seen_region:
            seen_region[key] = len(regions)
            kind = key[0]
            if kind == "heap":
                heap_n += 1
                name = f"heap#{heap_n}"
            else:
                name = key[1]
            regions.append({"name": name, "base": key[2], "bytes": key[3], "elem": sz, "kind": kind})
            min_size[key] = sz
        elif sz < min_size[key]:
            min_size[key] = sz
            regions[seen_region[key]]["elem"] = sz
        sp = span.setdefault(seen_region[key], [a, a + sz])
        sp[0], sp[1] = min(sp[0], a), max(sp[1], a + sz)
    # Unnamed memory (a section, or a page outside the program): show only the part that was touched.
    for i, reg in enumerate(regions):
        if reg["kind"] in ("section", "other") and i in span:
            lo_, hi_ = span[i][0] & ~15, (span[i][1] + 15) & ~15
            reg["base"], reg["bytes"] = lo_, hi_ - lo_
    if stack_lo is not None:
        base = stack_lo & ~63
        regions.append({"name": "stack", "base": base, "bytes": stack_hi - base, "elem": 1, "kind": "stack"})
    regions.sort(key=lambda r: r["base"])

    note = (f"Valgrind traced {total} loads/stores; kept {len(ops)} made by your code"
            if scope == "code" else f"Valgrind traced {total} loads/stores (everything, including startup and libraries)")
    if truncated:
        note += f" (cut off at {max_accesses})"
    t = Trace(ops=ops, addrs=addrs, sizes=sizes, marks=[], regions=regions, truncated=truncated,
              line_ids=line_ids, lines=lines_tab, note=note)
    return {"build": b, "run": run, "trace": t}
