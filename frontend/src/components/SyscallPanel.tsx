import { useEffect, useMemo, useRef } from "react";
import type { Frame, SyscallRecord } from "../system/types";

interface Props {
  frames: Frame[];
  version: number;
  index: number;
  live: boolean;
  totals: Map<string, { n: number; time_us: number; err: number }>;
  threadIndex: Map<number, number>;
  selectedTid: number | null;
  enabled: boolean;
}

const STREAM_FRAMES = 40; // how far back the stream looks
const STREAM_MAX = 200;

export default function SyscallPanel({ frames, version, index, live, totals, threadIndex, selectedTid, enabled }: Props) {
  // Totals up to the cursor (use the running totals when live; recompute when scrubbing).
  const top = useMemo(() => {
    let m: Map<string, { n: number; time_us: number; err: number }>;
    if (live) m = totals;
    else {
      m = new Map();
      for (let i = 0; i <= index && i < frames.length; i++) {
        const s = frames[i].tick.syscalls;
        if (!s) continue;
        for (const [k, v] of Object.entries(s.by_name)) {
          const c = m.get(k) ?? { n: 0, time_us: 0, err: 0 };
          c.n += v.n; c.time_us += v.time_us; c.err += v.err;
          m.set(k, c);
        }
      }
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, index, live, totals, frames]);

  const stream = useMemo(() => {
    const out: SyscallRecord[] = [];
    let dropped = 0;
    for (let i = Math.max(0, index - STREAM_FRAMES); i <= index && i < frames.length; i++) {
      const s = frames[i].tick.syscalls;
      if (!s) continue;
      dropped += s.dropped;
      for (const r of s.recent) if (selectedTid === null || r.tid === selectedTid) out.push(r);
    }
    return { rows: out.slice(-STREAM_MAX), dropped };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, index, frames, selectedTid]);

  const maxN = top.length ? top[0][1].n : 1;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [stream, live]);

  if (!enabled) return <div className="panel"><div className="panel-title">Syscalls</div><div className="muted">strace is off for this run.</div></div>;

  return (
    <div className="panel syscalls">
      <div className="panel-title">Top syscalls</div>
      <table className="sc-table">
        <tbody>
          {top.map(([name, s]) => (
            <tr key={name}>
              <td className="sc-name">{name}</td>
              <td className="sc-barcell"><div className="sc-bar" style={{ width: `${(s.n / maxN) * 100}%` }} /></td>
              <td className="num">{s.n}</td>
              <td className="num muted">{fmtUs(s.time_us)}</td>
              <td className="num bad">{s.err ? `${s.err} err` : ""}</td>
            </tr>
          ))}
          {top.length === 0 && <tr><td className="muted">none yet</td></tr>}
        </tbody>
      </table>
      <div className="panel-title">
        Syscall stream {selectedTid !== null && <span className="muted">· T{threadIndex.get(selectedTid)} only</span>}
        {stream.dropped > 0 && <span className="muted" title="only a sample of syscalls is streamed per tick; all are counted"> · sampled ({stream.dropped} not shown)</span>}
      </div>
      <div className="sc-stream" ref={listRef}>
        {stream.rows.map((r, i) => (
          <div key={i} className={`sc-row${r.err ? " err" : ""}${r.name === "signal" || r.name === "exit" ? " evt" : ""}`}>
            <span className="muted">{r.t.toFixed(3)}</span>{" "}
            <span className="tid">T{threadIndex.get(r.tid) ?? "?"}</span>{" "}
            <span className="sc-call">{r.name}</span>
            <span className="muted">({r.args})</span>
            {r.ret && <> = <span className={r.err ? "bad" : "ret"}>{r.ret}{r.err ? ` ${r.err}` : ""}</span></>}
            {r.dur_us > 0 && <span className="muted"> {fmtUs(r.dur_us)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtUs(us: number): string {
  if (us >= 1e6) return `${(us / 1e6).toFixed(2)}s`;
  if (us >= 1e3) return `${(us / 1e3).toFixed(1)}ms`;
  return `${us.toFixed(0)}µs`;
}
