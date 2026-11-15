import type { RunSummary } from "../system/runs";
import { fmtMs } from "./StatsBar";

interface Props {
  label: string;
  rows: RunSummary[];
  onClear: () => void;
}

/** Finished runs of one program node side by side: wall time vs total CPU vs per-core work. */
export default function RunHistory({ label, rows, onClear }: Props) {
  if (!rows.length) return null;
  const base = rows[0];
  return (
    <div className="panel run-history">
      <div className="panel-title">
        Runs of {label} <span className="muted">· speedup vs run #{base.n}</span>
        <span className="spacer" />
        <button className="btn small" onClick={onClear} title="Forget these runs">clear</button>
      </div>
      <table className="rh-table">
        <thead>
          <tr>
            <th>#</th>
            <th className="rh-args">args</th>
            <th title="wall-clock time: how long you waited">wall</th>
            <th title="total CPU time summed over all threads (user + kernel)">CPU</th>
            <th title="CPU ÷ wall: cores kept busy on average">cores</th>
            <th title="workers: threads that did ≥2% of the CPU time">workers</th>
            <th title="CPU ÷ workers: work each worker (≈ each core) did">CPU/worker</th>
            <th title={`run #${base.n}'s wall time ÷ this run's wall time`}>speedup</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n} title={`${r.outcome}${r.pinned ? ` · pinned to CPU ${r.pinned.join(",")}` : ""}${r.strace ? " · strace on" : ""} · ${r.threads} threads`}>
              <td className="muted">{r.n}</td>
              <td className="rh-args mono">{r.args || "(none)"}{r.outcome !== "exit 0" ? <span className="bad"> {r.outcome}</span> : null}</td>
              <td className="num">{fmtMs(r.wallMs)}</td>
              <td className="num">{fmtMs(r.cpuMs)}</td>
              <td className="num">{r.avgCores.toFixed(1)}</td>
              <td className="num">{r.workers}</td>
              <td className="num">{r.workers ? fmtMs(r.perWorkerMs) : "–"}</td>
              <td className="num"><b>{r.wallMs > 0 ? `${(base.wallMs / r.wallMs).toFixed(1)}×` : "–"}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small muted">
        More threads: wall time and CPU/worker fall, while total CPU stays about the same or grows (the same work,
        plus overhead, summed over every thread).
      </div>
    </div>
  );
}
