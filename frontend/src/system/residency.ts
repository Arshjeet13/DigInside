import type { Frame } from "./types";

export type PerCpu = Map<number, number>; // cpu -> ms on that CPU

export interface Residency {
  program: PerCpu;
  threads: Map<number, { perCpu: PerCpu; total: number; migrations: number; comm: string }>;
  total: number;
  migrations: number;
}

/**
 * Where the program's CPU time went, per core. Every sample, each thread's on-CPU time since the
 * previous sample (exact, from schedstat) is credited to the CPU it was on at sample time.
 */
export function computeResidency(frames: Frame[], upto: number): Residency {
  const r: Residency = { program: new Map(), threads: new Map(), total: 0, migrations: 0 };
  for (let i = 0; i <= upto && i < frames.length; i++) {
    for (const t of frames[i].tick.threads) {
      const ms = t.d_run_ms ?? 0;
      let th = r.threads.get(t.tid);
      if (!th) {
        th = { perCpu: new Map(), total: 0, migrations: 0, comm: t.comm };
        r.threads.set(t.tid, th);
      }
      if (t.migrated) {
        th.migrations++;
        r.migrations++;
      }
      if (ms <= 0) continue;
      th.perCpu.set(t.cpu, (th.perCpu.get(t.cpu) ?? 0) + ms);
      th.total += ms;
      r.program.set(t.cpu, (r.program.get(t.cpu) ?? 0) + ms);
      r.total += ms;
    }
  }
  return r;
}


/** Threads that did a meaningful share of the program's CPU time: the workers. (Counting cores
 * instead would be wrong: one thread that migrates between 3 cores would look like 3 parallel workers.) */
export function workerThreads(r: Residency, minShare = 0.02): number {
  let busiest = 0;
  for (const t of r.threads.values()) busiest = Math.max(busiest, t.total);
  let n = 0;
  // a worker does a real share of the total AND comparable work to the busiest thread
  for (const t of r.threads.values()) if (r.total > 0 && t.total / r.total >= minShare && t.total >= 0.1 * busiest) n++;
  return n;
}

export interface Parallelism {
  avgCores: number; // CPU time / wall time: how many cores were busy on average
  workers: number; // threads that did >= 2% of the work
  perWorkerMs: number; // CPU time / workers: what each worker (≈ each core, if they ran in parallel) did
}

export function parallelism(cpuMs: number, wallMs: number, r: Residency): Parallelism {
  const workers = workerThreads(r);
  return {
    avgCores: wallMs > 0 ? cpuMs / wallMs : 0,
    workers,
    perWorkerMs: workers > 0 ? cpuMs / workers : 0,
  };
}
