"""DigInside workspace: the folder of code files shown in the sidebar.

Files live in <repo>/workspace/. Compiled binaries go to workspace/.build/ (hidden).
All paths from the client are relative to the workspace and are validated so they
can't escape it.
"""
from __future__ import annotations

import asyncio
import os
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
CXXFLAGS = ["-O2", "-g", "-pthread", "-std=c++20", "-Wall"]
CFLAGS = ["-O2", "-g", "-pthread", "-Wall"]


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
            out.append({
                "path": p.relative_to(WORKSPACE).as_posix(),
                "lang": LANGS[p.suffix.lower()],
                "runnable": p.suffix.lower() in RUNNABLE,
                "size": st.st_size,
                "mtime": st.st_mtime,
            })
    return out


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
    out = _binary_for(p)
    if out.exists():
        out.unlink()


def _binary_for(src: Path) -> Path:
    rel = src.relative_to(WORKSPACE.resolve()).as_posix()
    return BUILD_DIR / rel.replace("/", "__").rsplit(".", 1)[0]


async def build(rel: str) -> dict:
    """Compile a C/C++ file if needed. Returns a 'build' message (ok, argv to run, compiler output)."""
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

    out = _binary_for(src)
    # Rebuild if the source or any header in the workspace is newer than the binary.
    newest = max([src.stat().st_mtime] + [h.stat().st_mtime for h in WORKSPACE.rglob("*.h*") if h.is_file()])
    if out.exists() and out.stat().st_mtime >= newest:
        return {"type": "build", "ok": True, "needed": False, "cached": True, "argv": [str(out)],
                "cmd": "", "output": "", "ms": 0}

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    compiler, flags = ("g++", CXXFLAGS) if ext != ".c" else ("gcc", CFLAGS)
    rel_src = src.relative_to(WORKSPACE.resolve()).as_posix()  # relative, so errors read "threads.cpp:12:3"
    cmd = [compiler, *flags, "-I", str(WORKSPACE), "-I", str(ROOT / "instrument"), "-o", str(out), rel_src]
    t0 = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, cwd=str(WORKSPACE))
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError:
        proc.kill()
        return {"type": "build", "ok": False, "needed": True, "argv": [], "output": "compile timed out", "ms": 120000}
    ok = proc.returncode == 0
    if not ok and out.exists():
        out.unlink()
    short = " ".join([compiler, *flags, "-o", f".build/{out.name}", rel_src])
    return {"type": "build", "ok": ok, "needed": True, "cached": False, "argv": [str(out)] if ok else [],
            "cmd": short, "output": stdout.decode(errors="replace"), "ms": round((time.monotonic() - t0) * 1000)}
