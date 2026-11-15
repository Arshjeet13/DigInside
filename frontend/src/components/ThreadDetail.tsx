import type { ThreadSample } from "../system/types";

export default function ThreadDetail({ t, idx, onClose }: { t: ThreadSample | null; idx: number; onClose: () => void }) {
  return (
    <div className="panel thread-detail">
      <div className="panel-title">
        Thread T{idx} <span className="spacer" />
        <button className="btn small" onClick={onClose}>×</button>
      </div>
      {!t ? (
        <div className="muted">not alive at this point in the run</div>
      ) : (
        <dl>
          <dt>tid / pid</dt><dd>{t.tid} / {t.pid} ({t.comm})</dd>
          <dt>state</dt><dd>{t.state}</dd>
          <dt>last CPU</dt><dd>{t.cpu}{t.migrated ? " (migrated this tick)" : ""}</dd>
          <dt>on-CPU / waiting</dt><dd>{Math.round(t.oncpu * 100)}% / {Math.round(t.runq * 100)}%</dd>
          <dt>user / kernel</dt><dd>{t.utime_ms.toFixed(0)} / {t.stime_ms.toFixed(0)} ms</dd>
          <dt>ctx sw vol / invol</dt><dd>{t.vcs} / {t.nvcs}</dd>
          <dt>page faults min / maj</dt><dd>{t.minflt} / {t.majflt}</dd>
        </dl>
      )}
    </div>
  );
}
