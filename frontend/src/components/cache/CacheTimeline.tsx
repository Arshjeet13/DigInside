import { useEffect, useMemo, useRef } from "react";
import type { SimResult } from "../../cache/types";
import { RESULT_COLOR } from "../../cache/state";

interface Props {
  sim: SimResult;
  cursor: number; // 0..n
  playing: boolean;
  speed: number;
  onSeek: (c: number) => void;
  onPlay: (p: boolean) => void;
  onSpeed: (s: number) => void;
}

const W = 1000;
const H = 60;
const SPEEDS = [1, 4, 16, 64, 256, 1024, 4096];

/** Stacked hit/miss mix over the run (one bar per bucket of accesses), marks, and transport controls. */
export default function CacheTimeline({ sim, cursor, playing, speed, onSeek, onPlay, onSpeed }: Props) {
  const ev = sim.events;
  const n = ev.n;
  const svg = useRef<SVGSVGElement>(null);
  const buckets = Math.min(n, 400);

  const bars = useMemo(() => {
    const out: { x: number; w: number; h: number[] }[] = [];
    if (!buckets) return out;
    const size = n / buckets;
    for (let k = 0; k < buckets; k++) {
      const lo = Math.floor(k * size), hi = Math.max(lo + 1, Math.floor((k + 1) * size));
      const c = [0, 0, 0, 0];
      for (let i = lo; i < hi && i < n; i++) c[ev.result[i]]++;
      const tot = hi - lo;
      out.push({ x: (lo / n) * W, w: Math.max(0.5, ((hi - lo) / n) * W), h: c.map((v) => (v / tot) * H) });
    }
    return out;
  }, [sim, n, buckets, ev.result]);

  const nextMiss = (from: number) => {
    for (let i = from; i < n; i++) if (ev.result[i] !== 0) return i + 1;
    return n;
  };
  const prevMiss = (from: number) => {
    for (let i = from - 2; i >= 0; i--) if (ev.result[i] !== 0) return i + 1;
    return 0;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key === "ArrowRight") onSeek(e.shiftKey ? nextMiss(cursor) : Math.min(n, cursor + 1));
      else if (e.key === "ArrowLeft") onSeek(e.shiftKey ? prevMiss(cursor) : Math.max(0, cursor - 1));
      else if (e.key === " ") onPlay(!playing);
      else if (e.key === "Home") onSeek(0);
      else if (e.key === "End") onSeek(n);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const seek = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    onSeek(Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * n));
  };

  return (
    <div className="timeline">
      <div className="tl-head">
        <button className="btn small" title="Start (Home)" onClick={() => onSeek(0)}>⏮</button>
        <button className="btn small" title="Previous miss (Shift+←)" onClick={() => onSeek(prevMiss(cursor))}>◀ miss</button>
        <button className="btn small" title="Step back (←)" onClick={() => onSeek(Math.max(0, cursor - 1))}>◀</button>
        <button className="btn small play" title="Play / pause (Space)" onClick={() => onPlay(!playing)}>{playing ? "❚❚" : "▶"}</button>
        <button className="btn small" title="Step forward (→)" onClick={() => onSeek(Math.min(n, cursor + 1))}>▶</button>
        <button className="btn small" title="Next miss (Shift+→)" onClick={() => onSeek(nextMiss(cursor))}>miss ▶</button>
        <button className="btn small" title="End" onClick={() => onSeek(n)}>⏭</button>
        <select className="speed" value={speed} onChange={(e) => onSpeed(Number(e.target.value))} title="Playback speed">
          {SPEEDS.map((s) => <option key={s} value={s}>{s} / s</option>)}
        </select>
        <span className="legend">
          {["hit", "cold", "conflict", "capacity"].map((l, i) => (
            <span key={l}><i className="sw" style={{ background: RESULT_COLOR[i] }} /> {l}</span>
          ))}
        </span>
        <span className="spacer" />
        <span className="tl-pos">access {cursor} / {n}</span>
      </div>
      <svg
        ref={svg}
        className="tl-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); seek(e.clientX); }}
        onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)}
      >
        {bars.map((bar, k) => {
          let y = H;
          return (
            <g key={k}>
              {[3, 2, 1, 0].map((r) => {
                const h = bar.h[r];
                y -= h;
                return h > 0 ? <rect key={r} x={bar.x} y={y} width={bar.w} height={h} fill={RESULT_COLOR[r]} opacity={r === 0 ? 0.35 : 0.9} /> : null;
              })}
            </g>
          );
        })}
        {sim.marks.map((m, k) => (
          <g key={k}>
            <line x1={(m.event / n) * W} x2={(m.event / n) * W} y1={0} y2={H} className="tl-mark" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        <line x1={(cursor / Math.max(1, n)) * W} x2={(cursor / Math.max(1, n)) * W} y1={0} y2={H} className="tl-cursor" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="tl-marks">
        {sim.marks.map((m, k) => (
          <button key={k} className="tl-mark-label" style={{ left: `${(m.event / Math.max(1, n)) * 100}%` }} onClick={() => onSeek(m.event)}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
