import { useEffect, useRef, useState } from "react";

/** Play through accesses at `speed` per second by advancing the cursor every animation frame. */
export function usePlayback(n: number, cursor: number, setCursor: (c: number) => void) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(16);
  const cur = useRef(cursor);
  cur.current = cursor;

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), acc = 0;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * speed;
      last = now;
      const step = Math.floor(acc);
      if (step > 0) {
        acc -= step;
        const next = Math.min(n, cur.current + step);
        setCursor(next);
        if (next >= n) {
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, n, setCursor]);

  return { playing, setPlaying, speed, setSpeed };
}
