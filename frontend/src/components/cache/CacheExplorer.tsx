import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SimResult } from "../../cache/types";
import {
  blockAddr, byteLabeled, describeAddr, hex, regionIndex, REGION_COLORS, RESULT_COLOR, RESULT_LABEL, sourceLineOf, splitAddr,
  type CacheState,
} from "../../cache/state";

interface Props {
  sim: SimResult;
  state: CacheState;
  current: number; // event just applied, -1 = none
}

interface VasRow {
  block: number; // block number = addr >> b
  addr: number;
  region: number;
  set: number;
  tag: number;
  first: number; // first element index overlapping this block
  last: number;
}

const MAX_VAS_ROWS = 8192;

/** Elements of `region` that overlap [addr, addr+B) — for labeling a block's bytes. */
function elementsIn(sim: SimResult, addr: number) {
  const B = sim.geometry.B;
  const out: { label: string; from: number; to: number; region: number }[] = [];
  let pos = addr;
  while (pos < addr + B) {
    const r = regionIndex(sim.regions, pos);
    if (r < 0) {
      // padding / unknown bytes until the next region or the end of the block
      let next = addr + B;
      for (const g of sim.regions) if (g.base > pos && g.base < next) next = g.base;
      out.push({ label: "", from: pos - addr, to: next - addr, region: -1 });
      pos = next;
      continue;
    }
    const g = sim.regions[r];
    if (byteLabeled(g)) {
      // stack / unnamed memory / SIMD-only: one segment for the part of the block inside this region
      const end = Math.min(addr + B, g.base + g.bytes);
      out.push({ label: g.kind === "stack" || g.kind === "other" ? g.name : `${g.name}+${pos - g.base}`, from: pos - addr, to: end - addr, region: r });
      pos = end;
      continue;
    }
    const idx = Math.floor((pos - g.base) / g.elem);
    const end = Math.min(g.base + (idx + 1) * g.elem, addr + B, g.base + g.bytes);
    out.push({ label: `${g.name}[${idx}]`, from: pos - addr, to: end - addr, region: r });
    pos = end;
  }
  return out;
}

export default function CacheExplorer({ sim, state, current }: Props) {
  const { S, E, B, s, b } = sim.geometry;
  const ev = sim.events;
  const cur = current >= 0
    ? { set: ev.set[current], way: ev.way[current], addr: ev.addr[current], res: ev.result[current], op: ev.op[current] }
    : null;

  const [follow, setFollow] = useState(true);
  const [selSet, setSelSet] = useState(0);
  const [selWay, setSelWay] = useState<number | null>(null);

  // Follow the current access unless the user took over.
  useEffect(() => {
    if (follow && cur) {
      setSelSet(cur.set);
      setSelWay(cur.way);
    }
  }, [follow, cur?.set, cur?.way, current]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelSet((x) => Math.min(x, S - 1));
    setSelWay((w) => (w !== null && w < E ? w : null));
  }, [S, E]);

  // Every block of every traced array, in address order.
  const vas = useMemo(() => {
    const rows: VasRow[] = [];
    for (let r = 0; r < sim.regions.length && rows.length < MAX_VAS_ROWS; r++) {
      const g = sim.regions[r];
      const firstBlock = Math.floor(g.base / B), lastBlock = Math.floor((g.base + g.bytes - 1) / B);
      for (let blk = firstBlock; blk <= lastBlock && rows.length < MAX_VAS_ROWS; blk++) {
        const addr = blk * B;
        const lo = Math.max(addr, g.base), hi = Math.min(addr + B, g.base + g.bytes) - 1;
        rows.push({
          block: blk, addr, region: r, set: blk % S, tag: Math.floor(blk / S),
          first: Math.floor((lo - g.base) / g.elem), last: Math.floor((hi - g.base) / g.elem),
        });
      }
    }
    return rows;
  }, [sim.regions, B, S]);
  const vasTotal = useMemo(
    () => sim.regions.reduce((a, g) => a + Math.floor((g.base + g.bytes - 1) / B) - Math.floor(g.base / B) + 1, 0),
    [sim.regions, B],
  );

  // Where is each memory block cached right now?  block number -> way index in its set
  const resident = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < state.tags.length; i++) {
      const t = state.tags[i];
      if (t >= 0) m.set(t * S + Math.floor(i / E), i % E);
    }
    return m;
  }, [state, S, E]);

  const lineBlock = (set: number, way: number) => {
    const t = state.tags[set * E + way];
    return t >= 0 ? t * S + set : -1;
  };
  const targetBlock = selWay !== null ? lineBlock(selSet, selWay) : -1;
  const curBlock = cur ? Math.floor(cur.addr / B) : -1;

  // ---- connectors (selected line -> its block in the VAS, selected set -> lines column)
  const root = useRef<HTMLDivElement>(null);
  const setsCol = useRef<HTMLDivElement>(null);
  const linesCol = useRef<HTMLDivElement>(null);
  const vasCol = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; color: string }[]>([]);

  const scrollIntoCol = (col: HTMLDivElement | null, el: Element | null) => {
    if (!col || !el) return;
    const c = col.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < c.top + 8 || r.bottom > c.bottom - 8) col.scrollTop += r.top - c.top - c.height / 2 + r.height / 2;
  };

  const measure = useCallback(() => {
    const rt = root.current?.getBoundingClientRect();
    if (!rt) return;
    const out: { d: string; color: string }[] = [];
    const curve = (x1: number, y1: number, x2: number, y2: number) => {
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    };
    const clampY = (y: number, col: HTMLDivElement | null) => {
      const c = col?.getBoundingClientRect();
      return c ? Math.min(Math.max(y, c.top - rt.top + 4), c.bottom - rt.top - 4) : y;
    };
    const setEl = setsCol.current?.querySelector(`[data-set="${selSet}"]`);
    const linesHead = linesCol.current?.querySelector(".lx-head");
    if (setEl && linesHead) {
      const a = setEl.getBoundingClientRect(), h = linesHead.getBoundingClientRect();
      out.push({ d: curve(a.right - rt.left, clampY(a.top + a.height / 2 - rt.top, setsCol.current), h.left - rt.left, h.top + h.height / 2 - rt.top), color: "#8a919e" });
    }
    if (selWay !== null && targetBlock >= 0) {
      const lineEl = linesCol.current?.querySelector(`[data-way="${selWay}"]`);
      const blkEl = vasCol.current?.querySelector(`[data-block="${targetBlock}"]`);
      if (lineEl && blkEl) {
        const a = lineEl.getBoundingClientRect(), z = blkEl.getBoundingClientRect();
        const r = regionIndex(sim.regions, targetBlock * B);
        out.push({
          d: curve(a.right - rt.left, clampY(a.top + a.height / 2 - rt.top, linesCol.current), z.left - rt.left, clampY(z.top + z.height / 2 - rt.top, vasCol.current)),
          color: r >= 0 ? REGION_COLORS[r % REGION_COLORS.length] : "#fff",
        });
      }
    }
    setPaths(out);
  }, [selSet, selWay, targetBlock, sim.regions, B]);

  // Keep the selected things on screen, then redraw connectors.
  useLayoutEffect(() => {
    scrollIntoCol(setsCol.current, setsCol.current?.querySelector(`[data-set="${selSet}"]`) ?? null);
    if (selWay !== null) scrollIntoCol(linesCol.current, linesCol.current?.querySelector(`[data-way="${selWay}"]`) ?? null);
    if (targetBlock >= 0) scrollIntoCol(vasCol.current, vasCol.current?.querySelector(`[data-block="${targetBlock}"]`) ?? null);
    measure();
  }, [selSet, selWay, targetBlock, state, measure]);

  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const cols = [setsCol.current, linesCol.current, vasCol.current];
    cols.forEach((c) => c?.addEventListener("scroll", on));
    window.addEventListener("resize", on);
    return () => {
      cols.forEach((c) => c?.removeEventListener("scroll", on));
      window.removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, [measure]);

  const pickSet = (set: number) => {
    setFollow(false);
    setSelSet(set);
    setSelWay(null);
  };
  const pickWay = (way: number) => {
    setFollow(false);
    setSelWay(way);
  };
  const pickBlock = (row: VasRow) => {
    setFollow(false);
    setSelSet(row.set);
    const w = resident.get(row.block);
    setSelWay(w ?? null);
  };

  const split = cur ? splitAddr(cur.addr, s, b) : null;
  const order = state.lru[selSet] ?? [];
  const regionColor = (r: number) => (r >= 0 ? REGION_COLORS[r % REGION_COLORS.length] : "#555d6b");

  return (
    <div className="lx" ref={root}>
      <div className="lx-access">
        {cur && split ? (
          <>
            <span className="lx-acc-op">{cur.op ? "store" : "load"}</span>
            <b>{describeAddr(sim.regions, cur.addr)}</b>
            <span className="muted">at</span>
            <span className="mono">{hex(cur.addr)}</span>
            <span className="muted">=</span>
            <span className="mono"><span className="ab-tag">tag {hex(split.tag)}</span> | <span className="ab-set">set {split.set}</span> | <span className="ab-off">offset {split.offset}</span></span>
            <span className="lx-res" style={{ background: RESULT_COLOR[cur.res] }}>{RESULT_LABEL[cur.res]}</span>
            {(() => {
              const sl = sourceLineOf(sim, current);
              return sl ? (
                <span className="lx-src" title={`${sl.file}:${sl.line} in ${sl.func}`}>
                  line {sl.line}: <code>{sl.text || sl.func}</code>
                </span>
              ) : null;
            })()}
          </>
        ) : (
          <span className="muted">No access yet: step forward (→) to see the first one.</span>
        )}
        <span className="spacer" />
        <label className="check" title="Open the set, line and memory block of each access as you step">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow current access
        </label>
      </div>

      <div className="lx-cols">
        {/* 1. sets */}
        <div className="lx-col lx-sets" ref={setsCol}>
          <div className="lx-col-title">Cache · {S} set{S === 1 ? "" : "s"}</div>
          {Array.from({ length: S }, (_, set) => (
            <div
              key={set}
              data-set={set}
              className={`lx-set${set === selSet ? " sel" : ""}${cur && cur.set === set ? " cur" : ""}`}
              onClick={() => pickSet(set)}
              style={cur && cur.set === set ? { borderColor: RESULT_COLOR[cur.res] } : undefined}
            >
              <span className="lx-set-name">set {set}</span>
              <span className="lx-set-lines">
                {Array.from({ length: E }, (_, w) => {
                  const t = state.tags[set * E + w];
                  const r = t >= 0 ? regionIndex(sim.regions, blockAddr(t, set, s, b)) : -1;
                  return <i key={w} className={t < 0 ? "empty" : ""} style={t >= 0 ? { background: regionColor(r) } : undefined} />;
                })}
              </span>
            </div>
          ))}
        </div>

        {/* 2. lines of the selected set */}
        <div className="lx-col lx-lines" ref={linesCol}>
          <div className="lx-col-title lx-head">
            Set {selSet} · {E} line{E === 1 ? "" : "s"}
            <span className="muted"> · every block whose set bits = {selSet} must live here</span>
          </div>
          {Array.from({ length: E }, (_, w) => {
            const idx = selSet * E + w;
            const t = state.tags[idx];
            const valid = t >= 0;
            const base = valid ? blockAddr(t, selSet, s, b) : -1;
            const isCur = cur && cur.set === selSet && cur.way === w;
            const rank = order.indexOf(w);
            const els = valid ? elementsIn(sim, base) : [];
            const curOff = isCur && cur ? cur.addr - base : -1;
            return (
              <div
                key={w}
                data-way={w}
                className={`lx-line${selWay === w ? " sel" : ""}${isCur ? " cur" : ""}`}
                style={isCur && cur ? { borderColor: RESULT_COLOR[cur.res] } : undefined}
                onClick={() => pickWay(w)}
              >
                <div className="lx-line-head">
                  <span className="lx-way">line {w}</span>
                  <span className={`lx-bit${valid ? " on" : ""}`} title="valid bit: does this line hold a block?">V={valid ? 1 : 0}</span>
                  <span className={`lx-bit${valid && state.dirty[idx] ? " dirty" : ""}`} title="dirty bit: modified since loaded; must be written back when evicted">
                    D={valid && state.dirty[idx] ? 1 : 0}
                  </span>
                  <span className="lx-tag mono" title="tag: the high bits of the block's address">tag {valid ? hex(t) : "—"}</span>
                  {E > 1 && valid && (
                    <span className="muted small">{rank === 0 ? "most recent" : rank === E - 1 ? "LRU: next victim" : `recency #${rank + 1}`}</span>
                  )}
                </div>
                {valid ? (
                  <>
                    <div className="lx-block" title={`block ${hex(base)}–${hex(base + B - 1)} (${B} bytes)`}>
                      {els.map((e, k) => {
                        const hit = curOff >= e.from && curOff < e.to;
                        return (
                          <span
                            key={k}
                            className={`lx-el${hit ? " touched" : ""}${e.region < 0 ? " pad" : ""}`}
                            style={{ flex: e.to - e.from, background: e.region >= 0 ? regionColor(e.region) : undefined }}
                            title={`${e.label || "padding"}: bytes ${e.from}–${e.to - 1} of the block (${hex(base + e.from)})`}
                          >
                            {e.label}
                          </span>
                        );
                      })}
                    </div>
                    <div className="small muted mono">block {hex(base)}–{hex(base + B - 1)} · {B} bytes</div>
                  </>
                ) : (
                  <div className="lx-block empty">empty: no block loaded yet</div>
                )}
              </div>
            );
          })}
          <div className="small muted lx-note">
            The trace records addresses, not values, so each block shows which array elements occupy its bytes.
          </div>
        </div>

        {/* 3. virtual address space */}
        <div className="lx-col lx-vas" ref={vasCol}>
          <div className="lx-col-title">
            Virtual address space · {B}-byte blocks
            <span className="muted"> · tinted = maps to set {selSet}</span>
          </div>
          {vas.map((row, k) => {
            const prev = k > 0 ? vas[k - 1] : null;
            const g = sim.regions[row.region];
            const way = resident.get(row.block);
            const inSel = row.set === selSet;
            const color = regionColor(row.region);
            return (
              <div key={row.block + ":" + row.region}>
                {(!prev || prev.region !== row.region) && (
                  <div className="lx-region" style={{ color }}>
                    ■ {g.name} · {g.bytes} bytes · {hex(g.base)}
                  </div>
                )}
                <div
                  data-block={row.block}
                  className={`lx-blk${inSel ? " insel" : ""}${row.block === targetBlock ? " target" : ""}${row.block === curBlock ? " cur" : ""}`}
                  onClick={() => pickBlock(row)}
                  style={row.block === targetBlock ? { borderColor: color } : undefined}
                  title={`block ${hex(row.addr)}: tag ${hex(row.tag)}, set ${row.set}${way !== undefined ? `, cached in line ${way}` : ", not cached"}`}
                >
                  <span className="mono lx-blk-addr">{hex(row.addr)}</span>
                  <span className="lx-blk-els">
                    {byteLabeled(g)
                      ? `${g.name}+${Math.max(row.addr, g.base) - g.base}`
                      : `${g.name}[${row.first}${row.last > row.first ? `..${row.last}` : ""}]`}
                  </span>
                  <span className="mono muted lx-blk-set">set {row.set}</span>
                  <span className={`lx-blk-res${way !== undefined ? " in" : ""}`} style={way !== undefined ? { background: color } : undefined}>
                    {way !== undefined ? `line ${way}` : ""}
                  </span>
                </div>
              </div>
            );
          })}
          {vasTotal > vas.length && <div className="small warn">showing the first {vas.length} of {vasTotal} blocks</div>}
          {vas.length === 0 && <div className="muted small">This trace has no named arrays.</div>}
        </div>
      </div>

      <svg className="lx-wires">
        {paths.map((p, k) => (
          <path key={k} d={p.d} stroke={p.color} />
        ))}
      </svg>
    </div>
  );
}
