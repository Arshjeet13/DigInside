import { memo } from "react";
import type { SimResult } from "../../cache/types";
import { blockAddr, describeAddr, hex, regionIndex, REGION_COLORS, RESULT_COLOR, RESULT_LABEL, type CacheState } from "../../cache/state";

interface Props {
  sim: SimResult;
  state: CacheState;
  current: number; // index of the event just applied (-1 = none)
}

const GROUP = 32; // sets per column group

export function gridSize(S: number, E: number) {
  const cw = cellW(E);
  const groups = Math.ceil(S / GROUP);
  const rows = Math.min(S, GROUP);
  return { width: groups * (34 + E * (cw + 2) + 14), height: rows * 18 + 26 };
}

function cellW(E: number) {
  return E <= 2 ? 44 : E <= 4 ? 30 : E <= 8 ? 20 : 14;
}

/** Sets x ways. Each valid line is colored by the array its block belongs to; brightness = recency. */
function CacheGrid({ sim, state, current }: Props) {
  const { S, E, s, b, B } = sim.geometry;
  const ev = sim.events;
  const curSet = current >= 0 ? ev.set[current] : -1;
  const curWay = current >= 0 ? ev.way[current] : -1;
  const curRes = current >= 0 ? ev.result[current] : -1;
  const cw = cellW(E);
  const groups = Math.ceil(S / GROUP);

  const cols = [];
  for (let g = 0; g < groups; g++) {
    const rows = [];
    for (let set = g * GROUP; set < Math.min(S, (g + 1) * GROUP); set++) {
      const order = state.lru[set];
      const cells = [];
      for (let w = 0; w < E; w++) {
        const idx = set * E + w;
        const tag = state.tags[idx];
        const isCur = set === curSet && w === curWay;
        let bg = "transparent", title = `set ${set}, way ${w}: empty (invalid)`, opacity = 1;
        if (tag >= 0) {
          const base = blockAddr(tag, set, s, b);
          const r = regionIndex(sim.regions, base);
          bg = r >= 0 ? REGION_COLORS[r % REGION_COLORS.length] : "#8a919e";
          const rank = order.indexOf(w);
          opacity = E > 1 ? 1 - (0.55 * rank) / (E - 1) : 1;
          title = [
            `set ${set}, way ${w}${state.dirty[idx] ? "  (dirty: modified, must be written back)" : ""}`,
            `tag ${hex(tag)}  →  block ${hex(base)}–${hex(base + B - 1)}`,
            `holds ${describeAddr(sim.regions, base)} … ${describeAddr(sim.regions, base + B - 1)}`,
            E > 1 ? `recency: ${rank === 0 ? "most recently used" : rank === E - 1 ? "least recently used (next victim)" : `#${rank + 1} of ${E}`}` : "",
          ].filter(Boolean).join("\n");
        }
        cells.push(
          <div
            key={w}
            className={`cg-cell${tag < 0 ? " empty" : ""}${isCur ? " current" : ""}`}
            style={{
              width: cw,
              background: bg,
              opacity: isCur ? 1 : opacity,
              outlineColor: isCur ? RESULT_COLOR[curRes] : undefined,
              boxShadow: isCur ? `0 0 10px ${RESULT_COLOR[curRes]}` : undefined,
            }}
            title={isCur ? `${RESULT_LABEL[curRes].toUpperCase()}\n${title}` : title}
          >
            {tag >= 0 && state.dirty[idx] ? <span className="cg-dirty" /> : null}
          </div>,
        );
      }
      rows.push(
        <div key={set} className={`cg-row${set === curSet ? " cur-set" : ""}`}>
          <span className="cg-set">{set}</span>
          {cells}
        </div>,
      );
    }
    cols.push(
      <div key={g} className="cg-group">
        {rows}
      </div>,
    );
  }
  return (
    <div className="cache-grid">
      <div className="cg-head">
        <span>set</span>
        <span className="muted">
          {E} way{E > 1 ? "s" : ""} → {E === 1 ? "(direct-mapped)" : s === 0 ? "(fully associative)" : "(brighter = more recently used)"}
        </span>
      </div>
      <div className="cg-groups">{cols}</div>
    </div>
  );
}

export default memo(CacheGrid);
