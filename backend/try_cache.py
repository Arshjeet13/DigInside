"""Terminal client for POST /run_cache — prints the miss breakdown (and optionally each access).

    backend/.venv/bin/python backend/try_cache.py matmul.cpp "32 ijk" -s 5 -E 1 -b 5
    backend/.venv/bin/python backend/try_cache.py transpose.cpp "8 naive 4 0" -s 2 -E 1 -b 5 -v
    backend/.venv/bin/python backend/try_cache.py mine.cpp "" --origin workspace
    backend/.venv/bin/python backend/try_cache.py cache/arrays16.c "" --origin workspace --tracer valgrind -s 2 -E 1 -b 4 -v
"""
import argparse
import json
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("file")
ap.add_argument("args", nargs="?", default="")
ap.add_argument("--origin", default="examples", choices=["examples", "workspace"])
ap.add_argument("-s", type=int, default=5)
ap.add_argument("-E", type=int, default=1)
ap.add_argument("-b", type=int, default=5)
ap.add_argument("-v", action="store_true", help="print every access (first 200)")
ap.add_argument("--tracer", default="tarray", choices=["tarray", "valgrind"], help="valgrind: trace the real machine code (any C/C++)")
ap.add_argument("--all", action="store_true", help="valgrind: keep every access, not just your code's")
ap.add_argument("--url", default="http://127.0.0.1:8000/run_cache")
a = ap.parse_args()

body = {"origin": a.origin, "file": a.file, "args": a.args, "s": a.s, "E": a.E, "b": a.b,
        "tracer": a.tracer, "scope": "all" if a.all else "code"}
req = urllib.request.Request(a.url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
try:
    r = json.loads(urllib.request.urlopen(req).read())
except urllib.error.HTTPError as e:
    raise SystemExit(f"error {e.code}: {json.loads(e.read())['detail']}")

b = r["build"]
print(f"build: {'cached' if b['cached'] else b['cmd']}" + ("" if b["ok"] else "\n" + b["output"]))
if not r["ok"]:
    raise SystemExit(r.get("error") or f"failed at {r['stage']}")
print("program:", r["run"]["output"].strip())
sim = r["sim"]
g, st = sim["geometry"], sim["stats"]
if sim.get("note"):
    print(sim["note"])
print(f"cache: S={g['S']} sets x E={g['E']} ways x B={g['B']} bytes = {g['size']} bytes")
print(f"accesses {st['accesses']} ({st['reads']} R / {st['writes']} W){' TRUNCATED' if sim['truncated'] else ''}")
print(f"hits {st['hits']}  misses {st['misses']} ({1 - st['hit_rate']:.1%}): cold {st['cold']}, conflict {st['conflict']}, "
      f"capacity {st['capacity']}  evictions {st['evictions']}  write-backs {st['writebacks']}")
if a.v:
    ev, names = sim["events"], sim["result_names"]
    for i in range(min(ev["n"], 200)):
        ln = sim["lines"][ev["line"][i]] if sim.get("lines") and ev["line"][i] >= 0 else None
        print(f"  {'RW'[ev['op'][i]]} {ev['addr'][i]:x}  set {ev['set'][i]:3d} way {ev['way'][i]}  {names[ev['result'][i]]:8s}"
              + (f"  line {ln['line']}: {ln['text']}" if ln else "")
              + (f"  (evict tag {ev['evict'][i]:x})" if ev["evict"][i] >= 0 else "") + ("  write-back" if ev["wb"][i] else ""))
