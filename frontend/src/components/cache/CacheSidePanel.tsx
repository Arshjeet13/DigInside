import type { CacheResponse, CacheStats, SimResult } from "../../cache/types";
import { describeAddr, hex, RESULT_COLOR, RESULT_LABEL, splitAddr, type CacheState } from "../../cache/state";

interface Props {
  resp: CacheResponse;
  sim: SimResult;
  state: CacheState;
  current: number;
  onJump: (cursor: number) => void;
}

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "–");

function StatsTable({ now, total }: { now: CacheStats; total: CacheStats }) {
  const rows: [string, keyof CacheStats, string | undefined][] = [
    ["hits", "hits", RESULT_COLOR[0]],
    ["cold misses", "cold", RESULT_COLOR[1]],
    ["conflict misses", "conflict", RESULT_COLOR[2]],
    ["capacity misses", "capacity", RESULT_COLOR[3]],
  ];
  const lookupsNow = now.hits + now.misses;
  const lookupsAll = total.hits + total.misses;
  return (
    <table className="cs-table">
      <thead>
        <tr><th /><th>so far</th><th className="muted">whole run</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, k, color]) => (
          <tr key={k}>
            <td><i className="sw" style={{ background: color }} /> {label}</td>
            <td className="num">{now[k] as number} <span className="muted">{pct(now[k] as number, lookupsNow)}</span></td>
            <td className="num muted">{total[k] as number} ({pct(total[k] as number, lookupsAll)})</td>
          </tr>
        ))}
        <tr className="cs-sep"><td>miss rate</td><td className="num"><b>{pct(now.misses, lookupsNow)}</b></td><td className="num muted">{pct(total.misses, lookupsAll)}</td></tr>
        <tr><td>accesses (R / W)</td><td className="num">{now.accesses} ({now.reads}/{now.writes})</td><td className="num muted">{total.accesses}</td></tr>
        <tr><td>evictions</td><td className="num">{now.evictions}</td><td className="num muted">{total.evictions}</td></tr>
        <tr><td>write-backs</td><td className="num">{now.writebacks}</td><td className="num muted">{total.writebacks}</td></tr>
      </tbody>
    </table>
  );
}

function Explain({ sim, current }: { sim: SimResult; current: number }) {
  const { s, b, E, S } = sim.geometry;
  const ev = sim.events;
  if (current < 0) return <div className="muted small">No access yet. Step forward to see the first one.</div>;
  const addr = ev.addr[current];
  const { tag, set, offset } = splitAddr(addr, s, b);
  const t = 32 - s - b;
  const bits = addr.toString(2).padStart(32, "0");
  const res = ev.result[current];
  const way = ev.way[current];
  const evicted = ev.evict[current];
  const where = E === 1 ? `the one line of set ${set}` : `the ${E} lines of set ${set}`;
  const why = [
    `Found tag ${hex(tag)} in ${where} (way ${way}). Nothing goes to memory.`,
    `First time this program touches this block, so no cache could have it yet (compulsory miss).`,
    `This block was cached earlier but got evicted because other blocks also map to set ${set}. A fully associative cache of the same size would still hold it: the set mapping caused this miss.`,
    `This block was cached earlier but evicted: the data in use is bigger than the cache. Even a fully associative cache of the same size would have evicted it.`,
  ][res];
  return (
    <div className="explain">
      <div className="ex-line">
        <b>{ev.op[current] ? "store to" : "load from"} {describeAddr(sim.regions, addr)}</b>
        <span className="mono muted"> {hex(addr)}</span>
      </div>
      <div className="addr-bits mono" title="32-bit address split into tag | set index | block offset">
        <span className="ab-tag">{bits.slice(0, t)}</span>
        <span className="ab-set">{bits.slice(t, t + s)}</span>
        <span className="ab-off">{bits.slice(t + s)}</span>
      </div>
      <div className="addr-legend small">
        <span className="ab-tag">tag {hex(tag)}</span> ({t} bits) ·{" "}
        <span className="ab-set">set {set}</span> ({s} bits{S === 1 ? ", only one set" : ""}) ·{" "}
        <span className="ab-off">offset {offset}</span> ({b} bits)
      </div>
      <div className="ex-result" style={{ borderColor: RESULT_COLOR[res] }}>
        <b style={{ color: RESULT_COLOR[res] }}>{RESULT_LABEL[res]}</b> — {why}
        {res > 0 && (
          <div className="small">
            Loaded into way {way}
            {evicted >= 0
              ? `, evicting the block with tag ${hex(evicted)}${E > 1 ? " (least recently used)" : ""}${ev.wb[current] ? ", which was dirty and is written back to memory" : ""}.`
              : " (it was empty)."}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CacheSidePanel({ resp, sim, state, current, onJump }: Props) {
  const ev = sim.events;
  const recent = [];
  for (let k = Math.max(0, current - 11); k <= current; k++) recent.push(k);
  return (
    <aside className="sidebar cache-side">
      <div className="panel">
        <div className="panel-title">This access</div>
        <Explain sim={sim} current={current} />
      </div>
      <div className="panel">
        <div className="panel-title">Statistics</div>
        <StatsTable now={state.stats} total={sim.stats} />
        {sim.truncated && <div className="small warn">Trace was cut off at the access limit; stats cover the traced part.</div>}
      </div>
      <div className="panel recent-panel">
        <div className="panel-title">Recent accesses (click to jump)</div>
        <div className="recent">
          {recent.map((k) => (
            <div key={k} className={`recent-row${k === current ? " cur" : ""}`} onClick={() => onJump(k + 1)}>
              <span className="muted mono">#{k + 1}</span>
              <span className="mono">{ev.op[k] ? "W" : "R"}</span>
              <span className="recent-what">{describeAddr(sim.regions, ev.addr[k])}</span>
              <span className="mono muted">set {ev.set[k]}</span>
              <span className="recent-res" style={{ color: RESULT_COLOR[ev.result[k]] }}>{RESULT_LABEL[ev.result[k]]}</span>
            </div>
          ))}
          {recent.length === 0 && <div className="muted small">none yet</div>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">Program</div>
        <pre className="output small">{(resp.build.cached ? "" : `$ ${resp.build.cmd}\n`) + (resp.run?.output.trim() || "(no output)")}</pre>
      </div>
    </aside>
  );
}
