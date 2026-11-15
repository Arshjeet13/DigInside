"""DigInside Cache mode runner: compile an instrumented C++ program, run it, collect its trace.

Programs use instrument/tarray.hpp; the trace goes to the file named by $DIGINSIDE_TRACE.
Sources come from instrument/examples/ ("examples") or the workspace ("workspace").
Binaries are cached in instrument/.build/, traces in memory (keyed by binary + args), so changing
only the cache geometry re-simulates without recompiling or re-running.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import shlex
import subprocess
import tempfile
import time
from collections import OrderedDict
from pathlib import Path

import workspace

ROOT = Path(__file__).resolve().parent.parent
INSTRUMENT = ROOT / "instrument"
EXAMPLES = INSTRUMENT / "examples"
BUILD_DIR = INSTRUMENT / ".build"
HEADER = INSTRUMENT / "tarray.hpp"

# -O1 keeps loops recognizable; every traced access is a call with side effects, so none are elided.
BUILD = "g++ -O1 -g -std=c++20 -Wall {src} -o {out}"
RUN_TIMEOUT_S = 30
DEFAULT_MAX_ACCESSES = 300_000
HARD_MAX_ACCESSES = 1_000_000

_trace_cache: OrderedDict[tuple, dict] = OrderedDict()
_TRACE_CACHE_SIZE = 8


class RunnerError(ValueError):
    pass


def _source(origin: str, file: str) -> Path:
    if origin == "examples":
        name = Path(file).name
        p = (EXAMPLES / name).resolve()
        if p.parent != EXAMPLES.resolve() or not p.is_file():
            raise RunnerError(f"no such example: {file}")
        return p
    if origin == "workspace":
        p = workspace.resolve(file)
        if not p.is_file():
            raise RunnerError(f"no such file: {file}")
        return p
    raise RunnerError(f"unknown origin {origin!r}")


def _describe(p: Path) -> dict:
    """First comment line = description; '// args: ...' = default args; '// cache: s E b' = suggested geometry."""
    desc, args, cache = "", "", None
    for line in p.read_text(errors="replace").splitlines()[:20]:
        if not line.startswith("//"):
            break
        body = line[2:].strip()
        if body.startswith("args:"):
            args = body[5:].strip()
        elif body.startswith("cache:"):
            try:
                s, E, b = (int(x) for x in body[6:].split()[:3])
                cache = {"s": s, "E": E, "b": b}
            except ValueError:
                pass
        elif not desc and body:
            desc = body
    return {"desc": desc, "args": args, "cache": cache}


def list_sources() -> list[dict]:
    """Examples plus workspace C++ files that include tarray.hpp."""
    out = []
    for p in sorted(EXAMPLES.glob("*.cpp")):
        out.append({"origin": "examples", "file": p.name, **_describe(p)})
    for f in workspace.list_files():
        if f["lang"] != "cpp" or not f["runnable"]:
            continue
        p = workspace.WORKSPACE / f["path"]
        try:
            if "tarray.hpp" in p.read_text(errors="replace"):
                out.append({"origin": "workspace", "file": f["path"], **_describe(p)})
        except OSError:
            pass
    return out


def read_source(origin: str, file: str) -> str:
    return _source(origin, file).read_text(errors="replace")


def _build_sync(src: Path) -> dict:
    key = hashlib.sha1(f"{src}|{BUILD}".encode()).hexdigest()[:10]
    out = BUILD_DIR / f"{src.stem}-{key}"
    newest = max(src.stat().st_mtime, HEADER.stat().st_mtime)
    if out.exists() and out.stat().st_mtime >= newest:
        return {"ok": True, "cached": True, "binary": str(out), "cmd": "", "output": "", "ms": 0}
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    argv = [t.replace("{src}", str(src)).replace("{out}", str(out)) for t in shlex.split(BUILD)] + ["-I", str(INSTRUMENT)]
    shown = shlex.join([t.replace("{src}", src.name).replace("{out}", f".build/{out.name}") for t in shlex.split(BUILD)]
                       + ["-I", "instrument"])
    t0 = time.monotonic()
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                           timeout=120, close_fds=True, cwd=str(src.parent))
    except subprocess.TimeoutExpired:
        return {"ok": False, "cached": False, "binary": "", "cmd": shown, "output": "compile timed out", "ms": 120000}
    ok = p.returncode == 0 and out.exists()
    return {"ok": ok, "cached": False, "binary": str(out) if ok else "", "cmd": shown,
            "output": p.stdout.decode(errors="replace"), "ms": round((time.monotonic() - t0) * 1000)}


def _run_sync(binary: str, args: list[str], max_accesses: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="diginside-cache-") as tmp:
        trace_path = os.path.join(tmp, "trace.txt")
        env = {**os.environ, "DIGINSIDE_TRACE": trace_path, "DIGINSIDE_MAX_ACCESSES": str(max_accesses)}
        t0 = time.monotonic()
        try:
            p = subprocess.run([binary, *args], env=env, cwd=tmp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               stdin=subprocess.DEVNULL, timeout=RUN_TIMEOUT_S, close_fds=True)
            code, out = p.returncode, p.stdout.decode(errors="replace")
        except subprocess.TimeoutExpired as e:
            code, out = None, (e.stdout or b"").decode(errors="replace") + f"\n[killed after {RUN_TIMEOUT_S} s]"
        ms = round((time.monotonic() - t0) * 1000)
        try:
            with open(trace_path) as f:
                trace = f.read()
        except FileNotFoundError:
            trace = ""
    lines = out.splitlines()
    if len(lines) > 200:
        out = "\n".join(lines[:200] + [f"[... {len(lines) - 200} more lines]"])
    return {"code": code, "output": out, "trace": trace, "ms": ms}


async def trace_program(origin: str, file: str, args: str, max_accesses: int = DEFAULT_MAX_ACCESSES) -> dict:
    """Build (if needed) and run; returns {"build", "run", "trace"}. Raises RunnerError for bad input."""
    src = _source(origin, file)
    if src.suffix not in (".cpp", ".cc", ".cxx"):
        raise RunnerError("Cache mode programs must be C++ files using tarray.hpp")
    try:
        argv = shlex.split(args or "")
    except ValueError as e:
        raise RunnerError(f"could not parse args: {e}")
    max_accesses = max(1, min(int(max_accesses), HARD_MAX_ACCESSES))

    build = await asyncio.to_thread(_build_sync, src)
    if not build["ok"]:
        return {"build": build, "run": None, "trace": None}

    key = (build["binary"], Path(build["binary"]).stat().st_mtime, tuple(argv), max_accesses)
    if key in _trace_cache:
        _trace_cache.move_to_end(key)
        cached = _trace_cache[key]
        return {"build": build, "run": {**cached["run"], "cached": True}, "trace": cached["trace"]}

    run = await asyncio.to_thread(_run_sync, build["binary"], argv, max_accesses)
    trace = run.pop("trace")
    run["cached"] = False
    if run["code"] == 0 or trace:
        _trace_cache[key] = {"run": run, "trace": trace}
        if len(_trace_cache) > _TRACE_CACHE_SIZE:
            _trace_cache.popitem(last=False)
    return {"build": build, "run": run, "trace": trace}

