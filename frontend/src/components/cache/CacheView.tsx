import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { fetchHardware, fetchSource, fetchSources, runCache } from "../../cache/api";
import type { CacheResponse, CacheSource, HardwareCache } from "../../cache/types";
import { stateAt } from "../../cache/state";
import CacheControls, { sourceKey, type Geo } from "./CacheControls";
import CacheCanvas from "./CacheCanvas";
import CacheExplorer from "./CacheExplorer";
import CacheSidePanel from "./CacheSidePanel";
import CacheTimeline from "./CacheTimeline";

interface Props {
  openCode: (title: string, lang: "cpp", load: () => Promise<string>) => void;
}

export default function CacheView({ openCode }: Props) {
  const [sources, setSources] = useState<CacheSource[]>([]);
  const [hardware, setHardware] = useState<HardwareCache[]>([]);
  const [key, setKey] = useState("");
  const [args, setArgs] = useState("");
  const [geo, setGeo] = useState<Geo>({ s: 5, E: 1, b: 5 });
  const [resp, setResp] = useState<CacheResponse | null>(null);
  const [ran, setRan] = useState<{ key: string; args: string } | null>(null); // what resp was traced from
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(16);
  const [view, setView] = useState<"explorer" | "grid">("explorer");
  const reqId = useRef(0);

  const src = sources.find((s) => sourceKey(s) === key);

  const run = useCallback(
    async (k: string, a: string, g: Geo, keepCursor = false) => {
      const s = sources.find((x) => sourceKey(x) === k);
      if (!s) return;
      const id = ++reqId.current;
      setBusy(ran && ran.key === k && ran.args === a ? "Simulating…" : "Compiling & tracing…");
      setError(null);
      setPlaying(false);
      try {
        const r = await runCache({ origin: s.origin, file: s.file, args: a, ...g });
        if (id !== reqId.current) return;
        setResp(r);
        setRan({ key: k, args: a });
        if (r.sim) setCursor((c) => (keepCursor ? Math.min(c, r.sim!.events.n) : r.sim!.events.n));
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setBusy(null);
      }
    },
    [sources, ran],
  );

  // Load programs + hardware presets, then run the first example once.
  useEffect(() => {
    Promise.all([fetchSources(), fetchHardware().catch(() => [])])
      .then(([srcs, hw]) => {
        setSources(srcs);
        setHardware(hw);
        const first = srcs.find((s) => s.file === "matmul.cpp") ?? srcs[0];
        if (first) {
          setKey(sourceKey(first));
          setArgs(first.args);
          if (first.cache) setGeo(first.cache);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRan.current && key && sources.length) {
      autoRan.current = true;
      run(key, args, geo);
    }
  }, [key, sources, args, geo, run]);

  // Geometry-only changes re-simulate the cached trace automatically.
  const geoKey = `${geo.s}-${geo.E}-${geo.b}`;
  const lastGeo = useRef(geoKey);
  useEffect(() => {
    if (lastGeo.current === geoKey) return;
    lastGeo.current = geoKey;
    // Only when the program and args are what was traced; otherwise wait for Run (needs a new trace).
    if (!ran || ran.key !== key || ran.args !== args || 2 ** geo.s * geo.E > 2048) return;
    const t = setTimeout(() => run(ran.key, ran.args, geo, true), 250);
    return () => clearTimeout(t);
  }, [geoKey, geo, ran, run, key, args]);

  const onSource = (k: string) => {
    setKey(k);
    const s = sources.find((x) => sourceKey(x) === k);
    if (s) {
      setArgs(s.args);
      if (s.cache) setGeo(s.cache);
    }
  };

  // Playback
  const sim = resp?.sim ?? null;
  const n = sim?.events.n ?? 0;
  useEffect(() => {
    if (!playing || !sim) return;
    let raf = 0, last = performance.now(), acc = 0;
    const tick = (now: number) => {
      acc += ((now - last) / 1000) * speed;
      last = now;
      const step = Math.floor(acc);
      if (step > 0) {
        acc -= step;
        setCursor((c) => {
          const next = Math.min(n, c + step);
          if (next >= n) setPlaying(false);
          return next;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, sim, n]);

  const state = useMemo(() => (sim ? stateAt(sim, cursor) : null), [sim, cursor]);
  const current = cursor - 1;
  const stale = ran && (ran.key !== key || ran.args !== args);

  return (
    <div className="cache-view">
      <CacheControls
        sources={sources}
        sourceKey={key}
        onSource={onSource}
        args={args}
        onArgs={setArgs}
        geo={geo}
        onGeo={setGeo}
        hardware={hardware}
        busy={busy}
        onRun={() => run(key, args, geo)}
        onViewCode={() => src && openCode(src.file, "cpp", () => fetchSource(src.origin, src.file))}
      />
      <div className="cache-main">
        <div className="cache-canvas">
          {error && <div className="status error">{error}</div>}
          {resp && !resp.ok && (
            <div className="status error">
              <b>{resp.stage === "build" ? "Compile failed" : resp.error ?? "Run failed"}</b>
              <pre className="output">{resp.stage === "build" ? `$ ${resp.build.cmd}\n${resp.build.output}` : resp.run?.output}</pre>
            </div>
          )}
          {stale && resp?.ok && <div className="cache-stale">Program or arguments changed — press Run to trace again.</div>}
          {sim && state && resp?.ok && (
            <div className="cache-viewtabs">
              <button className={view === "explorer" ? "tab active" : "tab"} onClick={() => setView("explorer")}>Explorer</button>
              <button className={view === "grid" ? "tab active" : "tab"} onClick={() => setView("grid")}>Grid overview</button>
            </div>
          )}
          {sim && state && resp?.ok && view === "explorer" && <CacheExplorer sim={sim} state={state} current={current} />}
          {sim && state && resp?.ok && view === "grid" && (
            <ReactFlowProvider>
              <CacheCanvas sim={sim} state={state} current={current} />
            </ReactFlowProvider>
          )}
          {!resp && !error && <div className="status">{busy ?? "Loading…"}</div>}
        </div>
        {sim && resp?.ok && (
          <CacheTimeline
            sim={sim}
            cursor={cursor}
            playing={playing}
            speed={speed}
            onSeek={(c) => { setPlaying(false); setCursor(c); }}
            onPlay={(p) => { if (p && cursor >= n) setCursor(0); setPlaying(p); }}
            onSpeed={setSpeed}
          />
        )}
      </div>
      {sim && state && resp?.ok && (
        <CacheSidePanel resp={resp} sim={sim} state={state} current={current} onJump={(c) => { setPlaying(false); setCursor(c); }} />
      )}
    </div>
  );
}
