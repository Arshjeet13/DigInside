import type { CacheStats, Region, SimResult } from "./types";

export const RESULT = { HIT: 0, COLD: 1, CONFLICT: 2, CAPACITY: 3 } as const;
export const RESULT_LABEL = ["hit", "cold miss", "conflict miss", "capacity miss"];
export const RESULT_COLOR = ["#3fb950", "#58a6ff", "#f0883e", "#ff7b72"]; // hit, cold, conflict, capacity

/** The cache's contents and running stats after the first `i` events. */
export interface CacheState {
  i: number;
  tags: number[];
  dirty: number[];
  lru: number[][];
  stats: CacheStats;
}

/** Load the nearest snapshot at or before i and replay events forward (at most snapshot_every). */
export function stateAt(sim: SimResult, i: number): CacheState {
  const n = sim.events.n;
  i = Math.max(0, Math.min(i, n));
  const snaps = sim.snapshots;
  let lo = 0, hi = snaps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (snaps[mid].i <= i) lo = mid;
    else hi = mid - 1;
  }
  const s0 = snaps[lo];
  const tags = s0.tags.slice();
  const dirty = s0.dirty.slice();
  const lru = s0.lru.map((l) => l.slice());
  const st: CacheStats = { ...s0.stats };
  const ev = sim.events;
  const { E, s, b } = sim.geometry;
  let lastSrc = s0.i > 0 ? ev.src[s0.i - 1] : -1;
  for (let k = s0.i; k < i; k++) {
    const set = ev.set[k], way = ev.way[k], res = ev.result[k];
    const idx = set * E + way;
    if (ev.src[k] !== lastSrc) {
      // one trace access may span several events (block-straddling); count it once
      st.accesses++;
      if (ev.op[k]) st.writes++;
      else st.reads++;
      lastSrc = ev.src[k];
    }
    if (res === RESULT.HIT) st.hits++;
    else {
      st.misses++;
      if (res === RESULT.COLD) st.cold++;
      else if (res === RESULT.CONFLICT) st.conflict++;
      else st.capacity++;
      if (ev.evict[k] >= 0) st.evictions++;
      if (ev.wb[k]) st.writebacks++;
      tags[idx] = Math.floor(ev.addr[k] / 2 ** (s + b));
      dirty[idx] = 0;
    }
    if (ev.op[k]) dirty[idx] = 1;
    const order = lru[set];
    order.splice(order.indexOf(way), 1);
    order.unshift(way);
  }
  return { i, tags, dirty, lru, stats: st };
}

/** Address of the first byte of the block held in (set, tag). */
export const blockAddr = (tag: number, set: number, s: number, b: number) => (tag * 2 ** s + set) * 2 ** b;

/** Split an address into tag / set index / block offset. */
export function splitAddr(addr: number, s: number, b: number) {
  const offset = addr % 2 ** b;
  const set = Math.floor(addr / 2 ** b) % 2 ** s;
  const tag = Math.floor(addr / 2 ** (s + b));
  return { tag, set, offset };
}

export const REGION_COLORS = ["#4c8dff", "#c678dd", "#2fbf8f", "#e5a50a", "#ef6f9a", "#56b6c2", "#d19a66", "#98c379"];

export function regionIndex(regions: Region[], addr: number): number {
  for (let r = 0; r < regions.length; r++) {
    const g = regions[r];
    if (addr >= g.base && addr < g.base + g.bytes) return r;
  }
  return -1;
}

/** True when element indices aren't meaningful: stack/other memory, or only wide (SIMD) accesses seen. */
export const byteLabeled = (g: Region) => g.kind === "stack" || g.kind === "other" || g.kind === "section" || g.elem > 8;

/** "A[37]" style label for an address (element index within its array); "g+16" / "stack 0x…" when
 * element indices aren't meaningful; hex if the address isn't in any known region. */
export function describeAddr(regions: Region[], addr: number): string {
  const r = regionIndex(regions, addr);
  if (r < 0) return `0x${addr.toString(16)}`;
  const g = regions[r];
  const off = addr - g.base;
  if (g.kind === "stack" || g.kind === "other") return `${g.name} 0x${addr.toString(16)}`;
  if (byteLabeled(g)) return `${g.name}+${off}`;
  return `${g.name}[${Math.floor(off / g.elem)}]`;
}

/** The source line that made event k, if the trace has line info (Valgrind traces). */
export function sourceLineOf(sim: SimResult, k: number) {
  const id = k >= 0 ? sim.events.line?.[k] ?? -1 : -1;
  return id >= 0 ? sim.lines?.[id] ?? null : null;
}

export const hex = (x: number) => `0x${x.toString(16)}`;

export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${+(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
