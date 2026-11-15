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

/** The most specific (smallest) region containing addr, or -1. Named locals sit inside the unnamed
 * "stack" region, so the smallest one wins. */
export function regionIndex(regions: Region[], addr: number): number {
  let best = -1;
  for (let r = 0; r < regions.length; r++) {
    const g = regions[r];
    if (addr >= g.base && addr < g.base + g.bytes && (best < 0 || g.bytes < regions[best].bytes)) best = r;
  }
  return best;
}

/** A single variable (not an array): label it by name only. */
export const isScalar = (g: Region) => g.bytes <= g.elem;

/** True when element indices aren't meaningful: unnamed memory, or only wide (SIMD) accesses seen. */
export const byteLabeled = (g: Region) =>
  g.kind === "stack" || g.kind === "other" || g.kind === "section" || (g.elem > 8 && !isScalar(g));

/** Label for the byte at addr inside region g: "g[3]", "i", "heap#1+16", "stack". */
export function labelIn(g: Region, addr: number): string {
  if (isScalar(g)) return g.name;
  if (g.kind === "stack" || g.kind === "other") return g.name;
  if (byteLabeled(g)) return `${g.name}+${addr - g.base}`;
  return `${g.name}[${Math.floor((addr - g.base) / g.elem)}]`;
}

/** "A[37]", "i", "g+16", "stack 0x…" for an address; hex if it isn't in any known region. */
export function describeAddr(regions: Region[], addr: number): string {
  const r = regionIndex(regions, addr);
  if (r < 0) return `0x${addr.toString(16)}`;
  const g = regions[r];
  if (g.kind === "stack" || g.kind === "other") return `${g.name} 0x${addr.toString(16)}`;
  return labelIn(g, addr);
}

export interface Segment {
  label: string;
  from: number; // byte offsets within the block
  to: number;
  region: number; // -1 = nothing known here
}

/** What occupies each byte range of the block starting at blockStart: one segment per element/variable. */
export function blockSegments(sim: SimResult, blockStart: number): Segment[] {
  const B = sim.geometry.B, endB = blockStart + B;
  const out: Segment[] = [];
  let pos = blockStart;
  while (pos < endB) {
    const r = regionIndex(sim.regions, pos);
    // the segment can't run past the start of any region that begins later inside this block
    let cut = endB;
    for (const g of sim.regions) if (g.base > pos && g.base < cut) cut = g.base;
    if (r < 0) {
      out.push({ label: "", from: pos - blockStart, to: cut - blockStart, region: -1 });
      pos = cut;
      continue;
    }
    const g = sim.regions[r];
    let end = Math.min(cut, g.base + g.bytes);
    if (!byteLabeled(g) && !isScalar(g)) end = Math.min(end, g.base + (Math.floor((pos - g.base) / g.elem) + 1) * g.elem);
    const label = labelIn(g, pos);
    const prev = out[out.length - 1];
    if (prev && prev.region === r && prev.label === label) prev.to = end - blockStart;
    else out.push({ label, from: pos - blockStart, to: end - blockStart, region: r });
    pos = end;
  }
  return out;
}

/** Short summary of a block's contents: "g[0..3]", "i, s, h", "local[0..3]". */
export function summarizeBlock(sim: SimResult, blockStart: number): string {
  const labels = blockSegments(sim, blockStart).filter((x) => x.region >= 0).map((x) => x.label);
  const parts: string[] = [];
  let i = 0;
  while (i < labels.length) {
    const m = /^(.*)\[(\d+)\]$/.exec(labels[i]);
    if (m) {
      let j = i;
      while (j + 1 < labels.length) {
        const n = /^(.*)\[(\d+)\]$/.exec(labels[j + 1]);
        if (!n || n[1] !== m[1] || Number(n[2]) !== Number(m[2]) + (j + 1 - i)) break;
        j++;
      }
      parts.push(j > i ? `${m[1]}[${m[2]}..${Number(m[2]) + (j - i)}]` : labels[i]);
      i = j + 1;
    } else {
      if (parts[parts.length - 1] !== labels[i]) parts.push(labels[i]);
      i++;
    }
  }
  return parts.join(", ") || "(nothing your program named)";
}

export type Area = "arrays" | "global" | "heap" | "stack" | "other";
export const AREA_TITLE: Record<Area, string> = {
  arrays: "Traced arrays (simulated addresses)",
  global: "Global variables & constants (fixed addresses)",
  heap: "Heap: memory from malloc / new",
  stack: "Stack: local variables",
  other: "Outside your program",
};
export function areaOf(g: Region | undefined): Area {
  switch (g?.kind) {
    case undefined: return g ? "arrays" : "other";
    case "global": case "section": return "global";
    case "heap": return "heap";
    case "local": case "stack": return "stack";
    default: return "other";
  }
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
