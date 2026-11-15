import { useMemo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useCanvasApi } from "./canvasContext";
import type { SimResult } from "../cache/types";
import { blockAddr, fmtBytes, regionIndex, REGION_COLORS, RESULT_COLOR, stateAt } from "../cache/state";

export type CacheModuleData = { name: string; s: number; E: number; b: number };
export type CacheModuleType = Node<CacheModuleData, "cache">;

export const CACHE_NODE_W = 290;

export function describeGeo(g: { s: number; E: number; b: number }) {
  const S = 2 ** g.s, B = 2 ** g.b;
  const kind = g.s === 0 ? "fully associative" : g.E === 1 ? "direct-mapped" : `${g.E}-way`;
  return { S, B, size: S * g.E * B, lines: S * g.E, kind };
}

const LIM = { s: [0, 10], E: [1, 32], b: [0, 8] } as const;

export default function CacheModuleNode({ id, data, selected }: NodeProps<CacheModuleType>) {
  const api = useCanvasApi();
  const run = api.getCacheRun(id);
  const prog = api.cacheProgram(id);
  const d = describeGeo(data);
  const presets = api.cachePresets(id);
  const sim = run?.resp?.sim ?? null;
  const state = useMemo(() => (sim ? stateAt(sim, run!.cursor) : null), [sim, run?.cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  const setGeo = (g: Partial<CacheModuleData>) => api.updateCache(id, g);
  const num = (k: "s" | "E" | "b") => (
    <label className="cm-num nodrag" title={{ s: "set index bits: S = 2^s sets", E: "lines per set", b: "block offset bits: B = 2^b bytes" }[k]}>
      {k}
      <input
        type="number"
        min={LIM[k][0]}
        max={LIM[k][1]}
        value={data[k]}
        onChange={(e) => setGeo({ [k]: Math.max(LIM[k][0], Math.min(LIM[k][1], Math.round(Number(e.target.value) || 0))) })}
      />
    </label>
  );

  let status: React.ReactNode;
  if (!prog) status = <span className="muted">Connect a program: drag from its ● handle to this cache.</span>;
  else if (prog.traced === false) status = <span className="warn">{prog.file} doesn't use tarray.hpp, so there's nothing to trace.</span>;
  else if (!run || run.status === "idle") status = <span className="muted">{prog.file} → press Run on it to fill this cache.</span>;
  else if (run.status === "tracing") status = <span className="warn">tracing {run.program?.file}…</span>;
  else if (run.status === "error") status = <span className="bad">{run.error}</span>;
  else if (sim && state) {
    const st = sim.stats, tot = st.hits + st.misses || 1;
    status = (
      <>
        <div className="cm-stats">
          <b>{(100 * (1 - (st.hit_rate ?? 0))).toFixed(1)}%</b> misses
          <span className="muted"> · {st.accesses} accesses of {run.program?.file}</span>
        </div>
        <div className="cm-mix" title={`hits ${st.hits} · cold ${st.cold} · conflict ${st.conflict} · capacity ${st.capacity}`}>
          {[st.hits, st.cold, st.conflict, st.capacity].map((v, i) => (
            <span key={i} style={{ flex: v / tot, background: RESULT_COLOR[i] }} />
          ))}
        </div>
        <div className="muted small">cold {st.cold} · conflict {st.conflict} · capacity {st.capacity}</div>
        <MiniGrid sim={sim} tags={state.tags} />
      </>
    );
  }

  return (
    <div className={`cache-module${selected ? " selected" : ""}`} style={{ width: CACHE_NODE_W }}>
      <Handle type="target" position={Position.Left} className="cm-handle" title="Connect a program here" />
      <div className="cm-head">
        <span className="cm-icon">▦</span>
        <span className="cm-name">{data.name}</span>
        <span className="muted small">{fmtBytes(d.size)} · {d.kind}</span>
      </div>
      <div className="cm-body">
        <select
          className="cm-preset nodrag"
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.label === e.target.value);
            if (p) setGeo(p.g);
          }}
        >
          <option value="">Presets…</option>
          {presets.map((p) => (
            <option key={p.label} value={p.label} disabled={p.disabled} title={p.title}>{p.label}</option>
          ))}
        </select>
        <div className="cm-geo">
          {num("s")}
          {num("E")}
          {num("b")}
          <span className="muted small mono">S={d.S} E={data.E} B={d.B}</span>
        </div>
        {d.lines > 2048 && <div className="bad small">S × E = {d.lines} lines; max 2048</div>}
        <div className="cm-status small">{status}</div>
        <button className="btn small nodrag" disabled={!sim} onClick={() => api.inspectCache(id)}>
          Inspect ▸
        </button>
      </div>
    </div>
  );
}

/** Tiny sets × ways picture, colored by array; sets wrap into columns so the block stays roughly square. */
function MiniGrid({ sim, tags }: { sim: SimResult; tags: number[] }) {
  const { S, E, s, b } = sim.geometry;
  const groups = Math.max(1, Math.min(8, Math.round(Math.sqrt(S / E))));
  const perGroup = Math.ceil(S / groups);
  const cell = Math.max(3, Math.min(10, Math.floor((262 - groups * 6) / (groups * E))));
  return (
    <div className="cm-mini" style={{ gridTemplateColumns: `repeat(${groups}, auto)` }} title="sets (rows) × lines (columns), colored by array">
      {Array.from({ length: groups }, (_, g) => (
        <div key={g} className="cm-mini-group" style={{ gridTemplateColumns: `repeat(${E}, ${cell}px)`, gridAutoRows: `${cell}px` }}>
          {Array.from({ length: Math.max(0, Math.min(perGroup, S - g * perGroup)) * E }, (_, k) => {
            const set = g * perGroup + Math.floor(k / E), w = k % E;
            const t = tags[set * E + w];
            const r = t >= 0 ? regionIndex(sim.regions, blockAddr(t, set, s, b)) : -1;
            return <i key={k} style={{ background: t < 0 ? "#22272f" : r >= 0 ? REGION_COLORS[r % REGION_COLORS.length] : "#8a919e" }} />;
          })}
        </div>
      ))}
    </div>
  );
}
