"""Terminal client for WS /ws/system — prints one compact line per tick.

    backend/.venv/bin/python backend/try_system.py "ls -l"
    backend/.venv/bin/python backend/try_system.py --no-strace "python3 workspace/gil.py 4"
    backend/.venv/bin/python backend/try_system.py --file threads.cpp --args "4 2 spin" --cpus 0,1
    backend/.venv/bin/python backend/try_system.py --file threads.cpp --args "4 3 spin" --repin 1:5 --repin 2:
                                  (at t=1s re-pin to CPU 5, at t=2s unpin)
"""
import argparse
import asyncio
import json

import websockets


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="")
    ap.add_argument("--file", help="workspace file to build+run")
    ap.add_argument("--args", default="")
    ap.add_argument("--cpus", default="", help="pin, e.g. 0,3")
    ap.add_argument("--repin", action="append", default=[], help="T:cpus  re-pin at T seconds")
    ap.add_argument("--no-strace", action="store_true")
    ap.add_argument("--interval", type=float, default=50)
    ap.add_argument("--url", default="ws://127.0.0.1:8000/ws/system")
    a = ap.parse_args()
    async with websockets.connect(a.url, max_size=None) as ws:
        cpus = [int(c) for c in a.cpus.split(",") if c]
        req = {"strace": not a.no_strace, "interval_ms": a.interval, "cpus": cpus}
        req.update({"file": a.file, "args": a.args} if a.file else {"cmd": a.cmd})
        await ws.send(json.dumps(req))
        repins = sorted((float(t), [int(c) for c in cs.split(",") if c]) for t, cs in (r.split(":") for r in a.repin))
        async for raw in ws:
            m = json.loads(raw)
            if m["type"] == "tick" and repins and m["t"] >= repins[0][0]:
                await ws.send(json.dumps({"type": "pin", "cpus": repins.pop(0)[1]}))
            if m["type"] == "build":
                print(f"BUILD ok={m['ok']} {m.get('cmd') or '(cached / not needed)'} {m.get('ms', 0)}ms")
                if m["output"]:
                    print(m["output"])
            elif m["type"] == "pinned":
                print(f"PINNED -> {m['cpus'] or 'all CPUs'} {m.get('error', '')}")
            elif m["type"] == "start":
                print(f"START {m['argv']} strace={m['strace']} cpus={m['cpus']} nproc={m['nproc']}")
            elif m["type"] == "tick":
                th = " ".join(f"{t['tid']}@cpu{t['cpu']}{'*' if t['migrated'] else ''}"
                              f"[{t['state']} {int(t['oncpu']*100)}%]" for t in m["threads"])
                sc = m["syscalls"]
                top = ",".join(f"{k}:{v['n']}" for k, v in list(sc["by_name"].items())[:3]) if sc else "-"
                busy = sum(1 for c in m["cores"] if c["user"] + c["kernel"] > 0.5)
                print(f"t={m['t']:6.2f} busy_cores={busy:2d} sys={sc['count'] if sc else '-':>5} {top:30s} {th}")
                for line in m["output"]["lines"]:
                    print(f"   | {line}")
            elif m["type"] == "exit":
                print(f"EXIT code={m['code']} signal={m['signal']} wall={m['wall_s']}s "
                      f"user={m['user_ms']}ms kernel={m['kernel_ms']}ms threads={len(m['threads'])}")
                if m["syscalls"]:
                    print("  top syscalls:", ", ".join(f"{s['name']}={s['n']}" for s in m["syscalls"][:8]))
                    print("  unparsed strace lines:", m["strace_unparsed"])
            else:
                print(m)


asyncio.run(main())
