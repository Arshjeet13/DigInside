// Messages streamed by WS /ws/system (see backend/system_monitor.py)

export interface ThreadSample {
  pid: number;
  tid: number;
  comm: string;
  state: string; // R running, S sleeping, D disk wait, t traced/stopped, Z zombie
  cpu: number; // last CPU the thread ran on
  migrated: boolean; // cpu changed since previous tick
  oncpu: number; // fraction of this tick spent on a CPU (0..1)
  runq: number; // fraction of this tick spent runnable but waiting for a CPU
  utime_ms: number;
  stime_ms: number;
  d_utime_ms: number;
  d_stime_ms: number;
  vcs: number;
  nvcs: number;
  d_vcs: number;
  d_nvcs: number;
  minflt: number;
  majflt: number;
  d_minflt: number;
  allowed: string; // Cpus_allowed_list, e.g. "0-15" or "3"
  d_run_ms: number; // on-CPU time since the previous sample (schedstat, ns precision)
}

export interface CoreSample {
  cpu: number;
  user: number; // machine-wide busy fraction this tick
  kernel: number;
}

export interface SyscallRecord {
  tid: number;
  t: number;
  name: string;
  args: string;
  ret: string;
  err: string | null;
  dur_us: number;
}

export interface SyscallStat {
  n: number;
  time_us: number;
  err: number;
}

export interface TickSyscalls {
  count: number;
  by_name: Record<string, SyscallStat>;
  by_tid: Record<string, number>;
  recent: SyscallRecord[];
  dropped: number;
}

export interface OutputChunk {
  lines: string[];
  dropped: number;
}

export interface StartMsg {
  type: "start";
  cmd: string;
  argv: string[];
  launcher_pid: number;
  cpus: number[] | null; // pinned CPUs, null = any
  strace: boolean;
  interval_ms: number;
  nproc: number;
  clk_tck: number;
}

export interface TickMsg {
  type: "tick";
  seq: number;
  t: number;
  dt: number;
  threads: ThreadSample[];
  cores: CoreSample[];
  syscalls: TickSyscalls | null;
  output: OutputChunk;
}

export interface ExitMsg {
  type: "exit";
  code: number | null;
  killed: boolean;
  signal: string | null;
  wall_s: number;
  output: OutputChunk;
  threads: ThreadSample[];
  user_ms: number;
  kernel_ms: number;
  syscalls: ({ name: string } & SyscallStat)[] | null;
  strace_unparsed: number;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

export interface BuildMsg {
  type: "build";
  ok: boolean;
  needed: boolean;
  cached?: boolean;
  argv: string[];
  cmd?: string;
  output: string;
  ms?: number;
}

export interface PinnedMsg {
  type: "pinned";
  cpus: number[] | null;
  error?: string;
}

export type SystemMsg = StartMsg | TickMsg | ExitMsg | ErrorMsg | BuildMsg | PinnedMsg;

/** What the client sends to start a run. */
export type RunRequest =
  | { cmd: string; strace: boolean; cpus?: number[]; interval_ms?: number }
  | { file: string; args: string; strace: boolean; cpus?: number[]; interval_ms?: number };

/** Running totals computed client-side as each tick arrives (includes exited threads). */
export interface TickAgg {
  user_ms: number;
  kernel_ms: number;
  vcs: number;
  nvcs: number;
  syscalls: number;
  oncpu: number; // sum of our threads' on-CPU fraction = "cores used by the program"
  machine: number; // sum of machine-wide busy fraction across all cores
  alive: number;
}

export interface Frame {
  tick: TickMsg;
  agg: TickAgg;
}
