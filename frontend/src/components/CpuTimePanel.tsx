import { useMemo } from "react";
import type { Frame } from "../system/types";

interface Props {
  frames: Frame[];
  version: number;
  index: number; // include frames[0..index]
  threadIndex: Map<number, number>;
  selectedTid: number | null;
  onSelectThread: (tid: number | null) => void;
  hue: number;
}

type PerCpu = Map<number, number>; // cpu -> ms on that CPU

interface Residency {
  program: PerCpu;
  threads: Map<number, { perCpu: PerCpu; total: number; migrations: number; comm: string }>;
  total: number;
  migrations: number;
}

/**
 * Where the program's CPU time went, per core. Every sample, each thread's on-CPU time since the
 * previous sample (exact, from schedstat) is credited to the CPU it was on at sample time.
 */
function computeResidency(frames: Frame[], upto: number): Residency {
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

const sorted = (m: PerCpu) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 1 : 0)} ms`);
const pct = (x: number, total: number) => (total > 0 ? (x / total) * 100 : 0);

function Bars({ perCpu, total, hue }: { perCpu: PerCpu; total: number; hue: number }) {
  const rows = sorted(perCpu);
  if (!rows.length) return <div className="muted small">no CPU time yet</div>;
  return (
    <table className="ct-table">
      <tbody>
        {rows.map(([cpu, ms]) => (
          <tr key={cpu}>
            <td className="ct-cpu">CPU {cpu}</td>
            <td className="ct-barcell">
              <div className="ct-bar" style={{ width: `${pct(ms, total)}%`, background: `hsl(${hue} 65% 55%)` }} />
            </td>
            <td className="num">{pct(ms, total).toFixed(1)}%</td>
            <td className="num muted">{fmtMs(ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CpuTimePanel({ frames, version, index, threadIndex, selectedTid, onSelectThread, hue }: Props) {
  const r = useMemo(
    () => computeResidency(frames, index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frames, version, index],
  );
  const sel = selectedTid !== null ? r.threads.get(selectedTid) : undefined;
  const threadRows = [...r.threads.entries()]
    .filter(([, t]) => t.total > 0)
    .sort((a, b) => (threadIndex.get(a[0]) ?? 0) - (threadIndex.get(b[0]) ?? 0));

  return (
    <div className="panel cputime">
      <div
        className="panel-title ct-title"
        title={"Estimated from 50 ms samples: each sample's on-CPU time (exact, from schedstat) is credited to the CPU the\n" +
          "thread was on at that moment. A thread that migrated mid-sample has that slice credited to its new CPU."}
      >
        CPU time by core <span className="muted ct-how">(how? hover)</span>
      </div>
      <div className="muted ct-sum">
        {fmtMs(r.total)} on-CPU · {r.program.size} CPU{r.program.size === 1 ? "" : "s"} · {r.migrations} migration{r.migrations === 1 ? "" : "s"}
      </div>

      {sel && selectedTid !== null ? (
        <>
          <div className="ct-sub">
            T{threadIndex.get(selectedTid)} <span className="muted">({sel.comm})</span> only ·{" "}
            <span className="muted">{fmtMs(sel.total)} · {sel.migrations} migrations</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => onSelectThread(null)}>whole program</button>
          </div>
          <Bars perCpu={sel.perCpu} total={sel.total} hue={hue} />
        </>
      ) : (
        <>
          <Bars perCpu={r.program} total={r.total} hue={hue} />
          {threadRows.length > 1 && (
            <>
              <div className="ct-sub muted">per thread (click to focus)</div>
              <div className="ct-threads">
                {threadRows.map(([tid, t]) => (
                  <div key={tid} className="ct-thread" onClick={() => onSelectThread(tid)} title={`tid ${tid} (${t.comm})`}>
                    <span className="tid">T{threadIndex.get(tid)}</span>
                    <span className="muted ct-ttotal">{fmtMs(t.total)}</span>
                    <span className="ct-tcpus">
                      {sorted(t.perCpu)
                        .slice(0, 3)
                        .map(([cpu, ms]) => `CPU ${cpu} ${pct(ms, t.total).toFixed(0)}%`)
                        .join(" · ")}
                      {t.perCpu.size > 3 ? ` · +${t.perCpu.size - 3} more` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
