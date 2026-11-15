import type { CacheSource, HardwareCache } from "../../cache/types";
import { fmtBytes } from "../../cache/state";

export interface Geo {
  s: number;
  E: number;
  b: number;
}

interface Props {
  sources: CacheSource[];
  sourceKey: string;
  onSource: (key: string) => void;
  args: string;
  onArgs: (a: string) => void;
  geo: Geo;
  onGeo: (g: Geo) => void;
  hardware: HardwareCache[];
  busy: string | null;
  onRun: () => void;
  onViewCode: () => void;
}

export const sourceKey = (s: CacheSource) => `${s.origin}:${s.file}`;

const LIMITS = { s: [0, 10], E: [1, 32], b: [0, 8] } as const;

function describe(g: Geo) {
  const S = 2 ** g.s, B = 2 ** g.b;
  const kind = g.s === 0 ? "fully associative" : g.E === 1 ? "direct-mapped" : `${g.E}-way set associative`;
  return { S, B, size: S * g.E * B, lines: S * g.E, kind };
}

export default function CacheControls(p: Props) {
  const src = p.sources.find((s) => sourceKey(s) === p.sourceKey);
  const d = describe(p.geo);
  const tooMany = d.lines > 2048;
  const presets: { label: string; g: Geo; title?: string; disabled?: boolean }[] = [];
  if (src?.cache) presets.push({ label: "This example's suggestion", g: src.cache });
  for (const h of p.hardware) {
    presets.push({
      label: `Your CPU's ${h.name}: ${fmtBytes(h.size)}, ${h.ways}-way, ${h.line} B`,
      g: { s: h.s, E: h.E, b: h.b },
      disabled: !h.fits,
      title: h.fits
        ? `${h.sets} sets × ${h.ways} ways × ${h.line} B, as reported by Linux (/sys/devices/system/cpu/cpu0/cache). Real geometry; the simulator still uses ideal LRU and no prefetching.`
        : `Too big to draw: ${h.why}`,
    });
  }
  presets.push(
    { label: "1 KB direct-mapped, 32 B blocks", g: { s: 5, E: 1, b: 5 } },
    { label: "1 KB 2-way, 32 B blocks", g: { s: 4, E: 2, b: 5 } },
    { label: "1 KB fully associative", g: { s: 0, E: 32, b: 5 } },
    { label: "Tiny: 4 sets, direct-mapped, 16 B", g: { s: 2, E: 1, b: 4 } },
  );

  const num = (k: keyof Geo, label: string, hint: string) => (
    <label className="geo-field" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        min={LIMITS[k][0]}
        max={LIMITS[k][1]}
        value={p.geo[k]}
        onChange={(e) => {
          const v = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], Math.round(Number(e.target.value) || 0)));
          p.onGeo({ ...p.geo, [k]: v });
        }}
      />
    </label>
  );

  return (
    <aside className="cache-controls">
      <div className="panel-title">Program</div>
      <select className="cc-select" value={p.sourceKey} onChange={(e) => p.onSource(e.target.value)}>
        {["examples", "workspace"].map((origin) => {
          const list = p.sources.filter((s) => s.origin === origin);
          if (!list.length) return null;
          return (
            <optgroup key={origin} label={origin === "examples" ? "Examples" : "Workspace (uses tarray.hpp)"}>
              {list.map((s) => (
                <option key={sourceKey(s)} value={sourceKey(s)}>{s.file}</option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {src && <div className="small muted cc-desc">{src.desc}</div>}
      <button className="btn small" onClick={p.onViewCode} disabled={!src}>View code</button>

      <div className="panel-title">Arguments</div>
      <input
        className="cc-args"
        value={p.args}
        spellCheck={false}
        onChange={(e) => p.onArgs(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && p.onRun()}
      />

      <div className="panel-title">Cache geometry</div>
      <div className="geo-row">
        {num("s", "s", "set index bits: S = 2^s sets")}
        {num("E", "E", "lines per set (associativity)")}
        {num("b", "b", "block offset bits: B = 2^b bytes per block")}
      </div>
      <div className="small geo-desc">
        S = {d.S} set{d.S === 1 ? "" : "s"} × E = {p.geo.E} × B = {d.B} B = <b>{fmtBytes(d.size)}</b>
        <br />
        {d.kind}
        {tooMany && <div className="bad">S × E = {d.lines} lines; max 2048</div>}
      </div>
      <div className="presets">
        {presets.map((pr) => (
          <button
            key={pr.label}
            className={`preset-btn${pr.g.s === p.geo.s && pr.g.E === p.geo.E && pr.g.b === p.geo.b ? " active" : ""}`}
            disabled={pr.disabled}
            title={pr.title}
            onClick={() => p.onGeo(pr.g)}
          >
            {pr.label}
          </button>
        ))}
      </div>
      <button className="btn run cc-run" onClick={p.onRun} disabled={!!p.busy || !src || tooMany}>
        {p.busy ?? "Run"}
      </button>
      <div className="small muted">
        Policies: LRU replacement, write-back + write-allocate. Changing only the geometry re-simulates the same trace
        instantly.
      </div>
    </aside>
  );
}
