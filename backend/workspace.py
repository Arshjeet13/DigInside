"""DigInside workspace: the folder of code files shown in the sidebar.

Files live in <repo>/workspace/. Compiled binaries go to workspace/.build/ (hidden).
All paths from the client are relative to the workspace and are validated so they
can't escape it.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import shlex
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = ROOT / "workspace"
BUILD_DIR = WORKSPACE / ".build"

LANGS = {
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".h": "c",
    ".c": "c", ".py": "python", ".sh": "shell",
}
RUNNABLE = {".cpp", ".cc", ".cxx", ".c", ".py", ".sh"}
MAX_FILE_BYTES = 1_000_000
# Build command templates: {src} = the source file, {out} = the binary DigInside will run.
DEFAULT_BUILD = {
    "cpp": "g++ -O2 -g -pthread -std=c++20 -Wall -fopenmp {src} -o {out}",
    "c": "gcc -O2 -g -pthread -Wall -fopenmp {src} -o {out} -lm",
}
# For these compilers, DigInside appends include paths for the workspace and instrument/ headers.
_COMPILER = re.compile(r"^(g\+\+|gcc|c\+\+|cc|clang\+\+|clang)(-\d+)?$")
BUILD_TIMEOUT_S = 120
INCLUDES_TARRAY = re.compile(r'^\s*#\s*include\s*[<"]tarray\.hpp[>"]', re.MULTILINE)


class WorkspaceError(ValueError):
    pass


def resolve(rel: str) -> Path:
    """Map a client path to a file inside the workspace, refusing anything outside it."""
    rel = (rel or "").strip().lstrip("/")
    if not rel or "\x00" in rel:
        raise WorkspaceError("empty path")
    p = (WORKSPACE / rel).resolve()
    if WORKSPACE.resolve() not in p.parents:
        raise WorkspaceError(f"path outside workspace: {rel}")
    if any(part.startswith(".") for part in p.relative_to(WORKSPACE.resolve()).parts):
        raise WorkspaceError(f"hidden paths are not allowed: {rel}")
    if p.suffix.lower() not in LANGS:
        raise WorkspaceError(f"unsupported file type {p.suffix or '(none)'}; allowed: {' '.join(sorted(LANGS))}")
    return p


def list_files() -> list[dict]:
    WORKSPACE.mkdir(exist_ok=True)
    out = []
    for dirpath, dirnames, filenames in os.walk(WORKSPACE):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if name.startswith(".") or p.suffix.lower() not in LANGS:
                continue
            st = p.stat()
            lang = LANGS[p.suffix.lower()]
            runnable = p.suffix.lower() in RUNNABLE
            hints = header_hints(p)
            out.append({
                "path": p.relative_to(WORKSPACE).as_posix(),
                "lang": lang,
                "runnable": runnable,
                "build": DEFAULT_BUILD.get(lang) if runnable else None,
                "args": hints["args"],
                "cache": hints["cache"],
                "traced": hints["traced"],
                "size": st.st_size,
                "mtime": st.st_mtime,
            })
    return out


def header_hints(p: Path) -> dict:
    """Read hints from a file's leading comments: '// args: ...' (or '# args:'), '// cache: s E b',
    and whether it uses tarray.hpp (so Cache modules can trace it)."""
    args, cache, traced = None, None, False
    try:
        text = p.read_text(errors="replace")
    except OSError:
        return {"args": None, "cache": None, "traced": False}
    traced = bool(INCLUDES_TARRAY.search(text))
    for line in text.splitlines()[:30]:
        body = line.strip()
        for prefix in ("//", "#"):
            if body.startswith(prefix):
                body = body[len(prefix):].strip()
                break
        else:
            continue
        if body.startswith("args:") and args is None:
            args = body[5:].strip()
        elif body.startswith("cache:") and cache is None:
            try:
                s, E, b = (int(x) for x in body[6:].split()[:3])
                cache = {"s": s, "E": E, "b": b}
            except ValueError:
                pass
    return {"args": args, "cache": cache, "traced": traced}


def read_file(rel: str) -> str:
    p = resolve(rel)
    if not p.is_file():
        raise WorkspaceError(f"no such file: {rel}")
    return p.read_text(errors="replace")


def write_file(rel: str, content: str) -> dict:
    p = resolve(rel)
    data = content.encode()
    if len(data) > MAX_FILE_BYTES:
        raise WorkspaceError(f"file too large ({len(data)} bytes, max {MAX_FILE_BYTES})")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return {"path": p.relative_to(WORKSPACE).as_posix(), "size": len(data)}


def delete_file(rel: str) -> None:
    p = resolve(rel)
    if not p.is_file():
        raise WorkspaceError(f"no such file: {rel}")
    p.unlink()
    for b in BUILD_DIR.glob(_binary_stem(p) + "-*"):
        b.unlink(missing_ok=True)


def _binary_stem(src: Path) -> str:
    rel = src.resolve().relative_to(WORKSPACE.resolve()).as_posix()
    return rel.replace("/", "__").rsplit(".", 1)[0]


def _binary_for(src: Path, template: str) -> Path:
    """One cached binary per (source, build command), so switching flags never runs a stale build."""
    return BUILD_DIR / f"{_binary_stem(src)}-{hashlib.sha1(template.encode()).hexdigest()[:8]}"


def _fail(msg: str, template: str, ms: int = 0) -> dict:
    return {"type": "build", "ok": False, "needed": True, "cached": False, "argv": [],
            "cmd": template, "template": template, "output": msg, "ms": ms}


async def build(rel: str, template: str | None = None) -> dict:
    """Compile a C/C++ file if needed, with the default or a custom build command template.

    Returns a 'build' message: ok, argv to run, the command shown to the user, compiler output.
    """
    src = resolve(rel)
    if not src.is_file():
        raise WorkspaceError(f"no such file: {rel}")
    ext = src.suffix.lower()
    if ext not in RUNNABLE:
        raise WorkspaceError(f"{rel} is not runnable (headers can't be run on their own)")
    if ext == ".py":
        return {"type": "build", "ok": True, "needed": False, "argv": ["python3", "-u", str(src)], "output": ""}
    if ext == ".sh":
        return {"type": "build", "ok": True, "needed": False, "argv": ["bash", str(src)], "output": ""}

    template = (template or "").strip() or DEFAULT_BUILD[LANGS[ext]]
    if "{src}" not in template or "{out}" not in template:
        return _fail("The build command must contain {src} (the source file) and {out} (the binary to run).\n"
                     f"Default: {DEFAULT_BUILD[LANGS[ext]]}", template)
    try:
        tokens = shlex.split(template)
    except ValueError as e:
        return _fail(f"Could not parse the build command: {e}", template)

    out = _binary_for(src, template)
    # Rebuild if the source or any header in the workspace is newer than the binary.
    newest = max([src.stat().st_mtime] + [h.stat().st_mtime for h in WORKSPACE.rglob("*.h*") if h.is_file()])
    if out.exists() and out.stat().st_mtime >= newest:
        return {"type": "build", "ok": True, "needed": False, "cached": True, "argv": [str(out)],
                "cmd": "", "template": template, "output": "", "ms": 0}

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    rel_src = src.relative_to(WORKSPACE.resolve()).as_posix()  # relative, so errors read "threads.cpp:12:3"
    argv = [t.replace("{src}", rel_src).replace("{out}", str(out)) for t in tokens]
    shown = [t.replace("{src}", rel_src).replace("{out}", f".build/{out.name}") for t in tokens]
    if _COMPILER.match(os.path.basename(argv[0])):
        argv += ["-I", str(WORKSPACE), "-I", str(ROOT / "instrument")]
        shown += ["-I", "workspace", "-I", "instrument"]
    cmd = shlex.join(shown)

    t0 = time.monotonic()
    ms = lambda: round((time.monotonic() - t0) * 1000)  # noqa: E731
    try:
        # No shell: the command is split like a shell would, but pipes/redirects aren't interpreted.
        proc = await asyncio.to_thread(
            subprocess.run, argv, cwd=str(WORKSPACE), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, timeout=BUILD_TIMEOUT_S, close_fds=True)
    except FileNotFoundError:
        return _fail(f"command not found: {argv[0]}", template, ms())
    except subprocess.TimeoutExpired:
        return _fail(f"build timed out after {BUILD_TIMEOUT_S} s", template, ms())
    output = proc.stdout.decode(errors="replace")
    ok = proc.returncode == 0
    if ok and not out.exists():
        ok = False
        output += "\nThe command succeeded but did not create {out} — make sure it writes the binary to {out}."
    if not ok and out.exists():
        out.unlink()
    return {"type": "build", "ok": ok, "needed": True, "cached": False, "argv": [str(out)] if ok else [],
            "cmd": cmd, "template": template, "output": output, "ms": ms()}
