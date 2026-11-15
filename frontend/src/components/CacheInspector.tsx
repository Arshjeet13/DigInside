import { useCallback, useEffect, useMemo } from "react";
import type { CacheResponse } from "../cache/types";
import { fmtBytes, stateAt } from "../cache/state";
import { usePlayback } from "../cache/usePlayback";
import CacheExplorer from "./cache/CacheExplorer";
import CacheSidePanel from "./cache/CacheSidePanel";
import CacheTimeline from "./cache/CacheTimeline";
import { describeGeo } from "./CacheModuleNode";

interface Props {
  name: string;
  program: string;
  resp: CacheResponse;
  cursor: number;
  onCursor: (c: number) => void;
  onClose: () => void;
}

/** Full-size view of one cache module: sets | lines | address space, stats, and the access timeline. */
export default function CacheInspector({ name, program, resp, cursor, onCursor, onClose }: Props) {
  const sim = resp.sim!;
  const n = sim.events.n;
  const setCursor = useCallback((c: number) => onCursor(Math.max(0, Math.min(n, c))), [onCursor, n]);
  const { playing, setPlaying, speed, setSpeed } = usePlayback(n, cursor, setCursor);
  const state = useMemo(() => stateAt(sim, cursor), [sim, cursor]);
  const g = sim.geometry;
  const d = describeGeo(g);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="cm-icon">▦</span>
        <b>{name}</b>
        <span className="muted">
          {fmtBytes(g.size)} · S={g.S} × E={g.E} × B={g.B} · {d.kind} · traced from <span className="mono">{program}</span>
        </span>
        <span className="spacer" />
        <span className="muted small">Esc to return to the canvas</span>
        <button className="btn small" onClick={onClose}>× Close</button>
      </div>
      <div className="insp-body">
        <div className="insp-main">
          <CacheExplorer sim={sim} state={state} current={cursor - 1} />
          <CacheTimeline
            sim={sim}
            cursor={cursor}
            playing={playing}
            speed={speed}
            onSeek={(c) => { setPlaying(false); setCursor(c); }}
            onPlay={(p) => { if (p && cursor >= n) setCursor(0); setPlaying(p); }}
            onSpeed={setSpeed}
          />
        </div>
        <CacheSidePanel resp={resp} sim={sim} state={state} current={cursor - 1} onJump={(c) => { setPlaying(false); setCursor(c); }} />
      </div>
    </div>
  );
}
