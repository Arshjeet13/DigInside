"""DigInside backend.

GET    /api/info              machine info (nproc) for the core canvas
GET    /api/files             workspace file list
GET    /api/file?path=        file content
PUT    /api/file              {"path", "content"} create/overwrite (used by upload)
DELETE /api/file?path=        delete
WS     /ws/system             System mode. Client sends one of
                                {"cmd": "ls -l", ...}                       run a shell-style command (cwd = repo root)
                                {"file": "threads.cpp", "args": "8 3", ...} build if needed, run (cwd = workspace)
                                  optional "build": "g++ -O3 {src} -o {out}" overrides the compile command
                              plus optional "strace": bool, "interval_ms": int, "cpus": [int] (pin; empty = any).
                              Server streams {"type": "build"|"start"|"tick"|"exit"|"error"|"pinned", ...}.
                              Client may send {"type": "stop"} or {"type": "pin", "cpus": [...]} (live re-pin).
GET    /api/cache/sources     Cache mode programs (instrument/examples + workspace files using tarray.hpp)
GET    /api/cache/source?origin=&file=   source code of one of them
GET    /api/cache/hardware    this CPU's data caches (from /sys) for "real geometry" presets
POST   /run_cache             Cache mode: {"origin", "file", "args", "s", "E", "b", "max_accesses"}
                              -> build info, program output, and the simulation (events + snapshots + stats)
"""
import asyncio
import os
import platform
import shlex

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

import cache_sim
import runner
import workspace
from system_monitor import SystemRun

app = FastAPI(title="DigInside")
app.add_middleware(GZipMiddleware, minimum_size=4096)  # Cache mode responses are large but repetitive


def online_cpus() -> list[int]:
    """CPU ids this process may run on (matches what the scheduler can use)."""
    try:
        return sorted(os.sched_getaffinity(0))
    except AttributeError:  # non-Linux fallback
        return list(range(os.cpu_count() or 1))


@app.get("/api/info")
def info() -> dict:
    cpus = online_cpus()
    return {
        "nproc": len(cpus),
        "cpus": cpus,
        "kernel": platform.release(),
        "machine": platform.machine(),
    }


# --------------------------------------------------------------------------- workspace files

class FileBody(BaseModel):
    path: str
    content: str


@app.get("/api/files")
def files() -> dict:
    return {"root": "workspace", "files": workspace.list_files()}


@app.get("/api/file")
def get_file(path: str) -> dict:
    try:
        return {"path": path, "content": workspace.read_file(path)}
    except workspace.WorkspaceError as e:
        raise HTTPException(400, str(e))


@app.put("/api/file")
def put_file(body: FileBody) -> dict:
    try:
        return workspace.write_file(body.path, body.content)
    except workspace.WorkspaceError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/file")
def del_file(path: str) -> dict:
    try:
        workspace.delete_file(path)
        return {"deleted": path}
    except workspace.WorkspaceError as e:
        raise HTTPException(400, str(e))


# --------------------------------------------------------------------------- System mode

@app.websocket("/ws/system")
async def ws_system(ws: WebSocket):
    await ws.accept()
    try:
        req = await ws.receive_json()
        opts = dict(
            use_strace=bool(req.get("strace", True)),
            interval=float(req.get("interval_ms", 50)) / 1000.0,
            cpus=req.get("cpus") or None,
        )
        if req.get("file"):
            b = await workspace.build(str(req["file"]), req.get("build") or None)
            await ws.send_json(b)
            if not b["ok"]:
                await ws.close()
                return
            argv = b["argv"] + shlex.split(str(req.get("args", "")))
            run = SystemRun(argv=argv, cwd=str(workspace.WORKSPACE), **opts)
        else:
            run = SystemRun(cmd=str(req.get("cmd", "")), cwd=str(workspace.ROOT), **opts)
    except WebSocketDisconnect:
        return
    except (ValueError, TypeError) as e:  # includes WorkspaceError and shlex errors
        await ws.send_json({"type": "error", "message": str(e)})
        await ws.close()
        return

    send_lock = asyncio.Lock()

    async def send(msg: dict):
        async with send_lock:
            await ws.send_json(msg)

    async def listen():
        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "stop":
                    run.stop()
                elif msg.get("type") == "pin":
                    try:
                        cpus = run.set_affinity(msg.get("cpus") or None)
                        await send({"type": "pinned", "cpus": cpus})
                    except ValueError as e:
                        await send({"type": "pinned", "cpus": run.cpus, "error": str(e)})
        except (WebSocketDisconnect, RuntimeError):
            run.stop()

    listener = asyncio.create_task(listen())
    try:
        async for msg in run.ticks():
            await send(msg)
        await ws.close()
    except (WebSocketDisconnect, RuntimeError):
        pass  # client went away; finally kills the run
    finally:
        run.stop()
        listener.cancel()


# --------------------------------------------------------------------------- Cache mode

class CacheRequest(BaseModel):
    origin: str = "examples"
    file: str
    args: str = ""
    s: int = 4
    E: int = 2
    b: int = 5
    max_accesses: int = runner.DEFAULT_MAX_ACCESSES
    tracer: str = "tarray"   # "tarray" | "valgrind"
    scope: str = "code"      # valgrind: "code" = only your code's accesses, "all" = everything
    build: str | None = None  # valgrind: the program's build command template


@app.get("/api/cache/sources")
def cache_sources() -> dict:
    return {"sources": runner.list_sources(), "limits": cache_sim.LIMITS}


@app.get("/api/cache/hardware")
def cache_hardware() -> dict:
    return {"caches": cache_sim.hardware_caches()}


@app.get("/api/cache/source")
def cache_source(origin: str, file: str) -> dict:
    try:
        return {"origin": origin, "file": file, "content": runner.read_source(origin, file)}
    except (runner.RunnerError, workspace.WorkspaceError) as e:
        raise HTTPException(400, str(e))


@app.post("/run_cache")
async def run_cache(req: CacheRequest) -> dict:
    geom = cache_sim.Geometry(req.s, req.E, req.b)
    try:
        cache_sim.validate(geom)
        if req.tracer not in ("tarray", "valgrind") or req.scope not in ("code", "all"):
            raise ValueError("tracer must be tarray|valgrind and scope code|all")
        r = await runner.trace_program(req.origin, req.file, req.args, req.max_accesses, req.tracer, req.scope, req.build)
    except (ValueError, runner.RunnerError, workspace.WorkspaceError) as e:
        raise HTTPException(400, str(e))
    if not r["build"]["ok"]:
        return {"ok": False, "stage": "build", "build": r["build"], "run": None, "sim": None}
    if not r["trace"] or not r["trace"].ops:
        why = ("the program produced no trace (does it use dig::tarray?)" if req.tracer == "tarray"
               else "Valgrind saw no memory accesses from your code")
        return {"ok": False, "stage": "run", "build": r["build"], "run": r["run"], "sim": None, "error": why}

    def sim() -> dict:
        return cache_sim.simulate(r["trace"], geom)

    result = await asyncio.to_thread(sim)
    return {"ok": True, "build": r["build"], "run": r["run"], "sim": result}
