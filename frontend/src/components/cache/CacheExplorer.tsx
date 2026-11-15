import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SimResult } from "../../cache/types";
import {
  AREA_TITLE, areaOf, blockAddr, blockSegments, describeAddr, hex, regionIndex, REGION_COLORS, RESULT_COLOR,
  sourceLineOf, summarizeBlock, type Area, type CacheState, type Segment,
} from "../../cache/state";

interface Props {
  sim: SimResult;
  state: CacheState;
  current: number; // event just applied, -1 = none
}

interface MemBlock {
  block: number; // block number = addr >> b
  addr: number;
  set: number;
  area: Area;
}

const MAX_BLOCKS = 8192;
const regionColor = (r: number) => (r >= 0 ? REGION_COLORS[r % REGION_COLORS.length] : "#555d6b");

/** A block drawn as its bytes: one labeled, colored cell per element / variable. */
function Strip({ segs, B, touchedOff }: { segs: Segment[]; B: number; touchedOff: number }) {
  return (
    <div className="lx-block">
      {segs.map((e, k) => {
        // name the array on the first cell of a run; later cells just show their index (color = same array)
        const m = /^(.*)\[(\d+)\]$/.exec(e.label);
        const prev = k > 0 ? segs[k - 1] : null;
        const short = m && prev && prev.region === e.region ? `[${m[2]}]` : e.label;
        return (
          <span
            key={k}
            className={`lx-el${touchedOff >= e.from && touchedOff < e.to ? " touched" : ""}${e.region < 0 ? " pad" : ""}`}
            style={{ flex: e.to - e.from, background: e.region >= 0 ? regionColor(e.region) : undefined }}
            title={`${e.label || "nothing named here"}: bytes ${e.from}–${e.to - 1} of this ${B}-byte block`}
          >
            {short}
          </span>
        );
      })}
    </div>
  );
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

  // Every memory block that holds something the program touched, in address order, grouped by area.
  const mem = useMemo(() => {
    const blocks = new Map<number, MemBlock>();
    for (const g of sim.regions) {
      const first = Math.floor(g.base / B), last = Math.floor((g.base + g.bytes - 1) / B);
      for (let blk = first; blk <= last && blocks.size < MAX_BLOCKS; blk++) {
        if (blocks.has(blk)) continue;
        const addr = blk * B;
        const r = regionIndex(sim.regions, Math.max(addr, g.base));
        blocks.set(blk, { block: blk, addr, set: blk % S, area: areaOf(sim.regions[r] ?? g) });
      }
    }
    return [...blocks.values()].sort((x, y) => x.addr - y.addr);
  }, [sim.regions, B, S]);

  const areaRegions = useMemo(() => {
    const m = new Map<Area, number[]>();
    sim.regions.forEach((g, r) => {
      const a = areaOf(g);
      m.set(a, [...(m.get(a) ?? []), r]);
    });
    return m;
  }, [sim.regions]);

  // block number -> way currently holding it
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

  // ---- wires
  const root = useRef<HTMLDivElement>(null);
  const setsCol = useRef<HTMLDivElement>(null);
  const linesCol = useRef<HTMLDivElement>(null);
  const memCol = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; color: string }[]>([]);

  const scrollIntoCol = (col: HTMLDivElement | null, el: Element | null) => {
    if (!col || !el) return;
    const c = col.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < c.top + 40 || r.bottom > c.bottom - 8) col.scrollTop += r.top - c.top - c.height / 2 + r.height / 2;
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
      const blkEl = memCol.current?.querySelector(`[data-block="${targetBlock}"]`);
      if (lineEl && blkEl) {
        const a = lineEl.getBoundingClientRect(), z = blkEl.getBoundingClientRect();
        out.push({
          d: curve(a.right - rt.left, clampY(a.top + a.height / 2 - rt.top, linesCol.current), z.left - rt.left, clampY(z.top + z.height / 2 - rt.top, memCol.current)),
          color: "#e6e6e6",
        });
      }
    }
    setPaths(out);
  }, [selSet, selWay, targetBlock]);

  useLayoutEffect(() => {
    scrollIntoCol(setsCol.current, setsCol.current?.querySelector(`[data-set="${selSet}"]`) ?? null);
    if (selWay !== null) scrollIntoCol(linesCol.current, linesCol.current?.querySelector(`[data-way="${selWay}"]`) ?? null);
    const memTarget = targetBlock >= 0 ? targetBlock : curBlock;
    if (memTarget >= 0) scrollIntoCol(memCol.current, memCol.current?.querySelector(`[data-block="${memTarget}"]`) ?? null);
    measure();
  }, [selSet, selWay, targetBlock, curBlock, state, measure]);

  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const cols = [setsCol.current, linesCol.current, memCol.current];
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
  const pickBlock = (m: MemBlock) => {
    setFollow(false);
    setSelSet(m.set);
    setSelWay(resident.get(m.block) ?? null);
  };

  const order = state.lru[selSet] ?? [];

  // ---- the story of the current access, in plain words
  let story: React.ReactNode = <span className="muted">No access yet: press → (or ▶) to run the program one memory access at a time.</span>;
  if (cur) {
    const sl = sourceLineOf(sim, current);
    const what = describeAddr(sim.regions, cur.addr);
    const r = regionIndex(sim.regions, cur.addr);
    const desc = r >= 0 ? sim.regions[r].desc : "";
    const blockStart = curBlock * B;
    const contents = summarizeBlock(sim, blockStart);
    const evicted = ev.evict[current];
    const evictedBlock = evicted >= 0 ? (evicted * S + cur.set) * B : -1;
    const verdict = [
      <>set {cur.set} already holds it → <b style={{ color: RESULT_COLOR[0] }}>hit</b>: no trip to memory.</>,
      <><b style={{ color: RESULT_COLOR[1] }}>cold miss</b>: first time this block is used, so it is copied from memory into set {cur.set}.</>,
      <><b style={{ color: RESULT_COLOR[2] }}>conflict miss</b>: it was in the cache before, but other blocks that also belong in set {cur.set} pushed it out.</>,
      <><b style={{ color: RESULT_COLOR[3] }}>capacity miss</b>: the program is using more data than the cache can hold, so this block had been pushed out.</>,
    ][cur.res];
    story = (
      <div className="lx-story">
        {sl && (
          <div className="lx-story-code">
            <span className="muted">line {sl.line}</span> <code>{sl.text || sl.func}</code>
          </div>
        )}
        <div>
          {cur.op ? "writes" : "reads"} <b className="lx-what" style={{ color: regionColor(r) }}>{what}</b>
          {desc && <span className="muted"> ({desc})</span>}
          {" "}→ it lives in the memory block <b>[{contents}]</b>, which belongs in <b className="ab-set">set {cur.set}</b> → {verdict}
          {cur.res > 0 && evicted >= 0 && (
            <span className="muted">
              {" "}It replaces [{summarizeBlock(sim, evictedBlock)}]{ev.wb[current] ? ", which was modified, so that block is first written back to memory" : ""}.
            </span>
          )}
        </div>
      </div>
    );
  }

  let lastArea: Area | null = null;

  return (
    <div className="lx" ref={root}>
      <div className="lx-access">
        {story}
        <label className="check lx-follow" title="Open the set, line and memory block of each access as you step">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
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
            <span className="muted"> · holds only blocks whose set bits = {selSet}</span>
          </div>
          {Array.from({ length: E }, (_, w) => {
            const idx = selSet * E + w;
            const t = state.tags[idx];
            const valid = t >= 0;
            const base = valid ? blockAddr(t, selSet, s, b) : -1;
            const isCur = !!cur && cur.set === selSet && cur.way === w;
            const rank = order.indexOf(w);
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
                  <span className={`lx-bit${valid && state.dirty[idx] ? " dirty" : ""}`} title="dirty bit: changed since it was loaded, so it must be written back to memory when replaced">
                    D={valid && state.dirty[idx] ? 1 : 0}
                  </span>
                  <span className="lx-tag mono" title="tag: the address bits above the set bits; tells which block this is">tag {valid ? hex(t) : "—"}</span>
                  {E > 1 && valid && (
                    <span className="muted small">{rank === 0 ? "used most recently" : rank === E - 1 ? "used longest ago: replaced next" : `recency #${rank + 1}`}</span>
                  )}
                </div>
                {valid ? (
                  <>
                    <Strip segs={blockSegments(sim, base)} B={B} touchedOff={isCur && cur ? cur.addr - base : -1} />
                    <div className="small muted">
                      holds <b className="lx-holds">{summarizeBlock(sim, base)}</b> · bytes {hex(base)}–{hex(base + B - 1)}
                    </div>
                  </>
                ) : (
                  <div className="lx-block empty">empty: nothing loaded here yet</div>
                )}
              </div>
            );
          })}
          <div className="small muted lx-note">
            A line holds one {B}-byte block: a copy of {B} neighbouring bytes of memory. The trace records addresses, not
            values, so cells show which variable each byte belongs to.
          </div>
        </div>

        {/* 3. memory */}
        <div className="lx-col lx-vas" ref={memCol}>
          <div className="lx-col-title">
            Your program's memory · {B}-byte blocks
            <span className="muted"> · tinted = belongs in set {selSet}</span>
          </div>
          {mem.map((m) => {
            const heading = m.area !== lastArea;
            lastArea = m.area;
            const way = resident.get(m.block);
            const segs = blockSegments(sim, m.addr);
            return (
              <div key={m.block}>
                {heading && (
                  <div className="mem-area">
                    <div className="mem-area-title">{AREA_TITLE[m.area]}</div>
                    <div className="mem-area-vars">
                      {(areaRegions.get(m.area) ?? []).map((r) => {
                        const g = sim.regions[r];
                        return (
                          <span key={r} className="mem-var" title={`${g.desc ?? ""} · ${g.bytes} bytes at ${hex(g.base)}`}>
                            <i style={{ background: regionColor(r) }} /> {g.name}
                            {g.bytes > g.elem && g.kind !== "stack" && g.kind !== "other" ? `[${Math.round(g.bytes / g.elem)}]` : ""}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div
                  data-block={m.block}
                  className={`mem-blk${m.set === selSet ? " insel" : ""}${m.block === targetBlock ? " target" : ""}${m.block === curBlock ? " cur" : ""}`}
                  onClick={() => pickBlock(m)}
                  title={`block ${hex(m.addr)}–${hex(m.addr + B - 1)} · belongs in set ${m.set}${way !== undefined ? ` · now in line ${way}` : " · not in the cache"}`}
                >
                  <span className="mem-addr mono">{hex(m.addr)}</span>
                  <Strip segs={segs} B={B} touchedOff={m.block === curBlock && cur ? cur.addr - m.addr : -1} />
                  <span className="mem-set mono">set {m.set}</span>
                  <span className={`mem-res${way !== undefined ? " in" : ""}`}>{way !== undefined ? `in line ${way}` : "not cached"}</span>
                </div>
              </div>
            );
          })}
          {mem.length >= MAX_BLOCKS && <div className="small warn">showing the first {MAX_BLOCKS} blocks</div>}
          {mem.length === 0 && <div className="muted small">This trace has no named memory.</div>}
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
