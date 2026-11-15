// Shapes returned by the Cache mode endpoints (see backend/cache_sim.py, backend/runner.py).

export interface CacheSource {
  origin: "examples" | "workspace";
  file: string;
  desc: string;
  args: string;
  cache: { s: number; E: number; b: number } | null;
}

export interface HardwareCache {
  name: string; // "L1d", "L2", ...
  size: number;
  ways: number;
  line: number;
  sets: number;
  s: number;
  E: number;
  b: number;
  fits: boolean;
  why: string;
}

export interface Geometry {
  s: number;
  E: number;
  b: number;
  S: number;
  B: number;
  lines: number;
  size: number;
}

export interface CacheStats {
  accesses: number;
  reads: number;
  writes: number;
  hits: number;
  misses: number;
  cold: number;
  conflict: number;
  capacity: number;
  evictions: number;
  writebacks: number;
  hit_rate?: number;
}

export interface Events {
  n: number;
  op: number[]; // 0 read, 1 write
  addr: number[];
  set: number[];
  way: number[];
  result: number[]; // 0 hit, 1 cold, 2 conflict, 3 capacity
  evict: number[]; // evicted tag or -1
  wb: number[]; // 1 = evicted line was dirty (write-back)
  src: number[]; // index of the trace access
  line?: number[]; // index into SimResult.lines (Valgrind traces), -1 = unknown
}

export interface Snapshot {
  i: number; // state after events [0, i)
  tags: number[]; // [set * E + way], -1 = invalid
  dirty: number[];
  lru: number[][]; // per set, ways MRU-first
  stats: CacheStats;
}

export interface Region {
  name: string;
  base: number;
  bytes: number;
  elem: number;
  kind?: "global" | "local" | "heap" | "stack" | "section" | "other"; // Valgrind traces; absent for tarray
  desc?: string; // plain-English description, e.g. "local variable of main()"
}

export interface SourceLine {
  file: string;
  line: number;
  func: string;
  text: string;
}

export interface SimResult {
  geometry: Geometry;
  stats: CacheStats;
  events: Events;
  snapshots: Snapshot[];
  snapshot_every: number;
  marks: { event: number; label: string }[];
  regions: Region[];
  truncated: boolean;
  result_names: string[];
  lines?: SourceLine[];
  note?: string;
}

export interface BuildInfo {
  ok: boolean;
  cached: boolean;
  cmd: string;
  output: string;
  ms: number;
}

export interface RunInfo {
  code: number | null;
  output: string;
  ms: number;
  cached: boolean;
}

export interface CacheResponse {
  ok: boolean;
  stage?: "build" | "run";
  error?: string;
  build: BuildInfo;
  run: RunInfo | null;
  sim: SimResult | null;
}

export interface CacheRequest {
  origin: string;
  file: string;
  args: string;
  s: number;
  E: number;
  b: number;
  tracer?: "tarray" | "valgrind";
  scope?: "code" | "all";
  build?: string;
}
