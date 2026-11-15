import { useRef } from "react";
import type { Frame } from "../system/types";

interface Props {
  frames: Frame[];
  version: number; // re-render trigger
  index: number;
  live: boolean;
  nproc: number;
  onSeek: (i: number) => void;
  onLive: () => void;
}

const W = 1000;
const H = 70;

/** Strip chart of cores used per tick (program vs whole machine), click/drag to scrub. */
export default function Timeline({ frames, index, live, nproc, onSeek, onLive }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const n = frames.length;
  // Auto-scale to the busiest moment (whole cores), so a 2-core program isn't a flat line on a 16-core axis.
  let peak = 0;
  for (const f of frames) peak = Math.max(peak, f.agg.oncpu, f.agg.machine);
  const ymax = Math.min(Math.max(1, nproc), Math.max(2, Math.ceil(peak * 1.15)));
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (Math.min(v, ymax) / ymax) * H;

  let ours = "", machine = "";
  frames.forEach((f, i) => {
    ours += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f.agg.oncpu).toFixed(1)}`;
    machine += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f.agg.machine).toFixed(1)}`;
  });
  const oursArea = n ? `${ours}L${x(n - 1)},${H}L0,${H}Z` : "";

  const seekFromEvent = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onSeek(Math.round(f * (n - 1)));
  };

  return (
    <div className="timeline">
      <div className="tl-head">
        <span>Timeline</span>
        <span className="legend"><i className="sw ours" /> cores used by program <i className="sw machine" /> whole machine · scale 0–{ymax} cores</span>
        <span className="spacer" />
        <span className="tl-pos">{n ? `tick ${index + 1}/${n} · ${frames[index]?.tick.t.toFixed(2)} s` : "no data"}</span>
        <button className={`btn small${live ? " active" : ""}`} onClick={onLive} disabled={live}>Live</button>
      </div>
      <svg
        ref={svg}
        className="tl-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); seekFromEvent(e.clientX); }}
        onPointerMove={(e) => e.buttons === 1 && seekFromEvent(e.clientX)}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} className="tl-grid" />
        ))}
        {n > 0 && <path d={oursArea} className="tl-ours-area" />}
        {n > 0 && <path d={ours} className="tl-ours" vectorEffect="non-scaling-stroke" />}
        {n > 0 && <path d={machine} className="tl-machine" vectorEffect="non-scaling-stroke" />}
        {n > 0 && <line x1={x(index)} x2={x(index)} y1={0} y2={H} className="tl-cursor" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}
