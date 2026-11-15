import { useMemo } from "react";
import type { ExitMsg, Frame } from "../system/types";
import type { RunSession, RunStatus } from "../system/runs";
import { computeResidency, parallelism } from "../system/residency";

interface Props {
  run: RunSession | null;
  frame: Frame | null;
  index: number; // frame shown (for CPU-per-core up to this point)
  version: number;
  atEnd: boolean;
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);

function statusText(status: RunStatus | "idle", exit: ExitMsg | null, error: string | null): [string, string] {
  if (status === "error") return [error ?? "error", "bad"];
  if (status === "connecting" || status === "building") return ["starting…", "warn"];
  if (status === "running") return ["running", "ok"];
  if (status === "exited" && exit) {
    if (exit.killed) return ["stopped", "warn"];
    if (exit.signal) return [`killed by ${exit.signal}`, "bad"];
    return [`exit ${exit.code}`, exit.code === 0 ? "ok" : "bad"];
  }
  if (status === "exited") return ["disconnected", "warn"];
  return ["idle", ""];
}

export default function StatsBar({ run, frame, index, version, atEnd }: Props) {
  const start = run?.start ?? null;
  const exit = run?.exit ?? null;
  const [text, cls] = statusText(run?.status ?? "idle", exit, run?.error ?? null);
  const a = frame?.agg;
  const t = frame?.tick;
  // When the run is over and we're at the end, the exit summary is the most complete total.
  const user = atEnd && exit ? exit.user_ms : a?.user_ms ?? 0;
  const kernel = atEnd && exit ? exit.kernel_ms : a?.kernel_ms ?? 0;
  const cpuTotal = user + kernel;
  const userPct = cpuTotal > 0 ? (user / cpuTotal) * 100 : 0;
  const rate = t?.syscalls && t.dt > 0 ? Math.round(t.syscalls.count / t.dt) : null;
  const wallMs = atEnd && exit ? exit.wall_s * 1000 : (t?.t ?? 0) * 1000;
  const res = useMemo(
    () => (run && index >= 0 ? computeResidency(run.frames, index) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, index, version],
  );
  const par = res && wallMs > 0 ? parallelism(cpuTotal, wallMs, res) : null;

  return (
    <div className="stats">
      <Stat label="showing">
        {run ? <span className="run-label" style={{ borderColor: `hsl(${run.meta.hue} 70% 55%)` }}>{run.meta.label}</span> : "–"}
      </Stat>
      <Stat label="pinned">{run ? (run.pinned?.length ? `CPU ${run.pinned.join(",")}` : "any") : "–"}</Stat>
      <Stat label="status"><span className={`pill ${cls}`}>{text}</span></Stat>
      <Stat label="time">{t ? `${t.t.toFixed(2)} s` : "–"}{atEnd && exit ? ` / ${exit.wall_s.toFixed(2)} s wall` : ""}</Stat>
      <Stat label="cores used by program" hint="sum of all threads' on-CPU share this tick">
        {a ? a.oncpu.toFixed(2) : "–"}
      </Stat>
      <Stat label="threads alive">{a ? a.alive : "–"}</Stat>
      <Stat label="CPU time: user / kernel" hint="utime / stime summed over all threads (10 ms resolution). With threads running in parallel this exceeds wall time.">
        <span className="uk">
          <span className="u">{user.toFixed(0)} ms</span> / <span className="k">{kernel.toFixed(0)} ms</span>
        </span>
        <div className="ratio">{cpuTotal > 0 && <><div className="seg-user" style={{ width: `${userPct}%` }} /><div className="seg-kernel" style={{ width: `${100 - userPct}%` }} /></>}</div>
      </Stat>
      <Stat label="avg cores busy" hint="CPU time ÷ wall time: how many cores the program kept busy on average. Grows with threads while wall time shrinks.">
        {par ? par.avgCores.toFixed(2) : "–"}
      </Stat>
      <Stat label="CPU time per worker" hint="CPU time ÷ worker threads (threads that did ≥2% of the work). Total CPU time adds up every thread, so it rises with more threads; this is what each worker (each core, when they run in parallel) actually did, and it falls as the work is split.">
        {par && par.workers > 0 ? `${fmtMs(par.perWorkerMs)} × ${par.workers}` : "–"}
      </Stat>
      <Stat label="context switches" hint="voluntary (blocked/slept) / involuntary (preempted)">
        {a ? `${a.vcs} / ${a.nvcs}` : "–"}
      </Stat>
      <Stat label="syscalls" hint={start && !start.strace ? "strace disabled" : "total (rate this tick)"}>
        {start && !start.strace ? "off" : a ? `${a.syscalls}${rate !== null ? ` (${rate}/s)` : ""}` : "–"}
      </Stat>
    </div>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}
