"""DigInside Cache mode: a deterministic set-associative cache simulator.

Geometry follows CS:APP: S = 2^s sets, E lines per set, B = 2^b bytes per block, so an address
splits into  tag | set index (s bits) | block offset (b bits).

Policies: LRU replacement, write-back + write-allocate (a write miss loads the block, then dirties it;
a dirty block is written back when evicted).

Every miss is classified with the "3 Cs":
    cold      first access ever to this block (compulsory)
    capacity  a fully-associative LRU cache with the same number of lines would also miss
    conflict  the fully-associative cache would have hit: the miss is caused by the set mapping

Output (see simulate()): columnar per-access events, periodic snapshots of the whole cache, and
cumulative stats, so a UI can jump to any access by loading the nearest snapshot and replaying.

CLI:  python cache_sim.py TRACE -s 4 -E 2 -b 5
"""
from __future__ import annotations

import argparse
import json
import math
import os
from collections import OrderedDict
from dataclasses import dataclass

HIT, COLD, CONFLICT, CAPACITY = 0, 1, 2, 3
RESULT_NAMES = ["hit", "cold", "conflict", "capacity"]


@dataclass(frozen=True)
class Geometry:
    s: int  # set index bits
    E: int  # lines per set (associativity)
    b: int  # block offset bits

    @property
    def S(self) -> int:
        return 1 << self.s

    @property
    def B(self) -> int:
        return 1 << self.b

    @property
    def lines(self) -> int:
        return self.S * self.E

    @property
    def size(self) -> int:
        return self.S * self.E * self.B

    def to_dict(self) -> dict:
        return {"s": self.s, "E": self.E, "b": self.b, "S": self.S, "B": self.B,
                "lines": self.lines, "size": self.size}


LIMITS = {"s": (0, 10), "E": (1, 32), "b": (0, 8), "lines": 2048}


def hardware_caches() -> list[dict]:
    """Data/unified caches of CPU 0 as Linux reports them (inside a VM: what the hypervisor reports)."""
    out = []
    base = "/sys/devices/system/cpu/cpu0/cache"
    try:
        entries = sorted(e for e in os.listdir(base) if e.startswith("index"))
    except OSError:
        return out
    for e in entries:
        def rd(name: str) -> str:
            try:
                with open(f"{base}/{e}/{name}") as f:
                    return f.read().strip()
            except OSError:
                return ""
        kind = rd("type")
        if kind not in ("Data", "Unified"):
            continue
        try:
            ways, line, sets = int(rd("ways_of_associativity")), int(rd("coherency_line_size")), int(rd("number_of_sets"))
        except ValueError:
            continue
        if line <= 0 or sets <= 0 or line & (line - 1) or sets & (sets - 1):
            continue  # not a power of two: can't express as s/b bits
        g = Geometry(sets.bit_length() - 1, ways, line.bit_length() - 1)
        try:
            validate(g)
            fits, why = True, ""
        except ValueError as err:
            fits, why = False, str(err)
        out.append({"name": f"L{rd('level')}{'d' if kind == 'Data' else ''}", "level": int(rd("level") or 0),
                    "size": g.size, "ways": ways, "line": line, "sets": sets,
                    "s": g.s, "E": g.E, "b": g.b, "fits": fits, "why": why})
    return out


def validate(g: Geometry) -> None:
    for name in ("s", "E", "b"):
        lo, hi = LIMITS[name]
        v = getattr(g, name)
        if not (lo <= v <= hi):
            raise ValueError(f"{name}={v} out of range [{lo}, {hi}]")
    if g.lines > LIMITS["lines"]:
        raise ValueError(f"S*E = {g.lines} lines is too many to display (max {LIMITS['lines']})")


@dataclass
class Trace:
    ops: list[int]        # 0 = read, 1 = write
    addrs: list[int]
    sizes: list[int]
    marks: list[dict]     # {"access": index of the next access, "label": str}
    regions: list[dict]   # {"name", "base", "bytes", "elem"}
    truncated: bool


def parse_trace(text: str) -> Trace:
    ops: list[int] = []
    addrs: list[int] = []
    sizes: list[int] = []
    marks: list[dict] = []
    regions: list[dict] = []
    truncated = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        c = line[0]
        if c == "R" or c == "W":
            parts = line.split()
            if len(parts) < 2:
                continue
            ops.append(1 if c == "W" else 0)
            addrs.append(int(parts[1], 16))
            sizes.append(int(parts[2]) if len(parts) > 2 else 1)
        elif line.startswith("# mark "):
            marks.append({"access": len(ops), "label": line[7:]})
        elif line.startswith("# alloc "):
            p = line.split()
            if len(p) >= 6:
                regions.append({"name": p[2], "base": int(p[3], 16), "bytes": int(p[4]), "elem": int(p[5])})
        elif line.startswith("# truncated"):
            truncated = True
    return Trace(ops, addrs, sizes, marks, regions, truncated)


def simulate(trace: Trace, g: Geometry, max_snapshots: int = 300) -> dict:
    """Run the trace through the cache. Accesses that straddle a block boundary become one event per
    block touched, so `events` may be longer than the trace."""
    validate(g)
    S, E, b, s = g.S, g.E, g.b, g.s
    set_mask = S - 1

    tags = [-1] * (S * E)        # flat [set * E + way]; -1 = invalid
    dirty = [0] * (S * E)
    lru = [list(range(E)) for _ in range(S)]  # per set: ways, most-recently-used first

    shadow: OrderedDict[int, None] = OrderedDict()  # fully-associative LRU of block numbers
    capacity = g.lines
    seen: set[int] = set()

    ev_op: list[int] = []
    ev_addr: list[int] = []
    ev_set: list[int] = []
    ev_way: list[int] = []
    ev_res: list[int] = []
    ev_evict: list[int] = []   # tag evicted from that way, -1 if none
    ev_wb: list[int] = []      # 1 if the evicted block was dirty (write-back)
    ev_src: list[int] = []     # index of the trace access that produced this event

    st = {"accesses": 0, "reads": 0, "writes": 0, "hits": 0, "misses": 0,
          "cold": 0, "conflict": 0, "capacity": 0, "evictions": 0, "writebacks": 0}

    n_est = sum(1 for _ in trace.ops)
    every = max(64, math.ceil(n_est / max(1, max_snapshots)))
    snapshots: list[dict] = []

    def snapshot(i: int) -> None:
        snapshots.append({"i": i, "tags": tags.copy(), "dirty": dirty.copy(),
                          "lru": [l.copy() for l in lru], "stats": dict(st)})

    snapshot(0)
    marks_out = []
    mark_iter = iter(trace.marks)
    next_mark = next(mark_iter, None)

    for idx in range(len(trace.ops)):
        while next_mark is not None and next_mark["access"] <= idx:
            marks_out.append({"event": len(ev_op), "label": next_mark["label"]})
            next_mark = next(mark_iter, None)
        op = trace.ops[idx]
        addr = trace.addrs[idx]
        size = max(1, trace.sizes[idx])
        first_block = addr >> b
        last_block = (addr + size - 1) >> b
        st["accesses"] += 1
        st["writes" if op else "reads"] += 1

        for blk in range(first_block, last_block + 1):
            if len(ev_op) % every == 0 and len(ev_op) > 0:
                snapshot(len(ev_op))
            set_i = blk & set_mask
            tag = blk >> s
            base = set_i * E
            order = lru[set_i]

            # shadow fully-associative cache (for conflict vs capacity)
            fa_hit = blk in shadow
            if fa_hit:
                shadow.move_to_end(blk)
            else:
                shadow[blk] = None
                if len(shadow) > capacity:
                    shadow.popitem(last=False)

            way = -1
            for w in range(E):
                if tags[base + w] == tag:
                    way = w
                    break

            evicted, wb = -1, 0
            if way >= 0:
                res = HIT
                st["hits"] += 1
            else:
                st["misses"] += 1
                if blk not in seen:
                    res = COLD
                elif fa_hit:
                    res = CONFLICT
                else:
                    res = CAPACITY
                st[RESULT_NAMES[res]] += 1
                # victim: first invalid way, else least recently used
                way = next((w for w in range(E) if tags[base + w] == -1), order[-1])
                if tags[base + way] != -1:
                    evicted = tags[base + way]
                    st["evictions"] += 1
                    if dirty[base + way]:
                        wb = 1
                        st["writebacks"] += 1
                tags[base + way] = tag
                dirty[base + way] = 0
            seen.add(blk)
            if op:
                dirty[base + way] = 1
            order.remove(way)
            order.insert(0, way)

            ev_op.append(op)
            ev_addr.append(addr if blk == first_block else blk << b)
            ev_set.append(set_i)
            ev_way.append(way)
            ev_res.append(res)
            ev_evict.append(evicted)
            ev_wb.append(wb)
            ev_src.append(idx)

    while next_mark is not None:
        marks_out.append({"event": len(ev_op), "label": next_mark["label"]})
        next_mark = next(mark_iter, None)
    if snapshots[-1]["i"] != len(ev_op):
        snapshot(len(ev_op))

    acc = st["hits"] + st["misses"]
    st["hit_rate"] = round(st["hits"] / acc, 4) if acc else 0.0
    return {
        "geometry": g.to_dict(),
        "stats": st,
        "events": {"n": len(ev_op), "op": ev_op, "addr": ev_addr, "set": ev_set, "way": ev_way,
                   "result": ev_res, "evict": ev_evict, "wb": ev_wb, "src": ev_src},
        "snapshots": snapshots,
        "snapshot_every": every,
        "marks": marks_out,
        "regions": trace.regions,
        "truncated": trace.truncated,
        "result_names": RESULT_NAMES,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trace")
    ap.add_argument("-s", type=int, default=4)
    ap.add_argument("-E", type=int, default=1)
    ap.add_argument("-b", type=int, default=4)
    ap.add_argument("-v", action="store_true", help="print every access (like csim -v)")
    ap.add_argument("--json", action="store_true", help="print the full result as JSON")
    a = ap.parse_args()
    with open(a.trace) as f:
        tr = parse_trace(f.read())
    r = simulate(tr, Geometry(a.s, a.E, a.b))
    if a.json:
        print(json.dumps(r))
        return
    if a.v:
        ev = r["events"]
        for i in range(ev["n"]):
            extra = " eviction" if ev["evict"][i] >= 0 else ""
            extra += " (write-back)" if ev["wb"][i] else ""
            print(f"{'RW'[ev['op'][i]]} {ev['addr'][i]:x} set {ev['set'][i]} way {ev['way'][i]} "
                  f"{RESULT_NAMES[ev['result'][i]]}{extra}")
    print(json.dumps(r["geometry"]))
    print(json.dumps(r["stats"]))


if __name__ == "__main__":
    main()
