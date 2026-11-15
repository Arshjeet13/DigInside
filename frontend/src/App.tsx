import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { fetchInfo, listFiles, type MachineInfo, type WorkspaceFile } from "./api";
import CoreCanvas from "./components/CoreCanvas";
import StatsBar from "./components/StatsBar";
import Timeline from "./components/Timeline";
import SyscallPanel from "./components/SyscallPanel";
import OutputPanel from "./components/OutputPanel";
import ThreadDetail from "./components/ThreadDetail";
import FileSidebar from "./components/FileSidebar";
import CpuTimePanel from "./components/CpuTimePanel";
import CodeViewer from "./components/CodeViewer";
import { useRunStore } from "./system/runs";
import CacheView from "./components/cache/CacheView";

type Mode = "system" | "cache";

export default function App() {
  const [info, setInfo] = useState<MachineInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("system");
  const store = useRunStore();
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null); // null = follow live
  const [selected, setSelected] = useState<{ key: string; tid: number } | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ path: string; lang: WorkspaceFile["lang"]; load?: () => Promise<string> } | null>(null);

  useEffect(() => {
    fetchInfo().then(setInfo).catch((e: Error) => setInfoError(e.message));
  }, []);

  const refreshFiles = useCallback(() => {
    listFiles()
      .then((f) => {
        setFiles(f);
        setFilesError(null);
      })
      .catch((e: Error) => setFilesError(e.message));
  }, []);
  useEffect(refreshFiles, [refreshFiles]);

  const focus = useCallback(
    (key: string) => {
      if (key !== focusedKey) {
        setCursor(null);
        setSelected(null);
      }
      setFocusedKey(key);
    },
    [focusedKey],
  );
  const onRunStarted = useCallback((key: string) => {
    setFocusedKey(key);
    setCursor(null);
    setSelected(null);
  }, []);
  const openCode = useCallback((path: string, lang: WorkspaceFile["lang"]) => setViewer({ path, lang }), []);

  const run = focusedKey ? store.get(focusedKey) ?? null : null;
  const frames = run?.frames ?? [];
  const n = frames.length;
  const index = cursor === null ? n - 1 : Math.min(cursor, n - 1);
  const frame = index >= 0 ? frames[index] : null;
  const atEnd = index === n - 1;
  const live = cursor === null;
  const selTid = selected && selected.key === focusedKey ? selected.tid : null;
  const selThread = selTid !== null ? frame?.tick.threads.find((t) => t.tid === selTid) ?? null : null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">DigInside</span>
        <nav className="tabs">
          <button className={mode === "system" ? "tab active" : "tab"} onClick={() => setMode("system")}>System</button>
          <button className={mode === "cache" ? "tab active" : "tab"} onClick={() => setMode("cache")}>Cache</button>
        </nav>
        <span className="spacer" />
        {info && (
          <span className="meta">
            {info.nproc} CPUs · {info.machine} · {info.kernel}
          </span>
        )}
      </header>

      {mode === "cache" ? (
        <CacheView openCode={(path, lang, load) => setViewer({ path, lang, load })} />
      ) : (
        <>
          <StatsBar run={run} frame={frame} atEnd={atEnd} />
          <div className="workspace">
            <FileSidebar files={files} error={filesError} onRefresh={refreshFiles} onOpen={(f) => openCode(f.path, f.lang)} />
            <main className="canvas">
              {infoError && <div className="status error">Backend unreachable: {infoError}</div>}
              {!infoError && !info && <div className="status">Loading…</div>}
              {info && (
                <ReactFlowProvider>
                  <CoreCanvas
                    cpus={info.cpus}
                    store={store}
                    focusedKey={focusedKey}
                    focusedIndex={index}
                    selected={selected}
                    onSelectThread={(key, tid) => {
                      if (tid === null) setSelected(null);
                      else {
                        focus(key);
                        setSelected({ key, tid });
                      }
                    }}
                    onFocus={focus}
                    onRunStarted={onRunStarted}
                    openCode={openCode}
                  />
                </ReactFlowProvider>
              )}
              <div className="canvas-legend">
                <span><i className="sw user" /> user</span>
                <span><i className="sw kernel" /> kernel</span>
                <span className="lg-sep">threads:</span>
                <span><i className="sw st-R" /> running</span>
                <span><i className="sw st-S" /> sleeping</span>
                <span><i className="sw st-D" /> I/O wait</span>
                <span><i className="sw st-traced" /> stopped by strace</span>
                <span className="muted">fill color = program · brightness = on-CPU share · flash = migrated</span>
              </div>
            </main>
            <aside className="sidebar">
              {selTid !== null && run && (
                <ThreadDetail t={selThread} idx={run.threadIndex.get(selTid) ?? 0} onClose={() => setSelected(null)} />
              )}
              {run && (
                <CpuTimePanel
                  frames={frames}
                  version={store.version}
                  index={index}
                  threadIndex={run.threadIndex}
                  selectedTid={selTid}
                  onSelectThread={(tid) => setSelected(tid === null ? null : { key: run.meta.key, tid })}
                  hue={run.meta.hue}
                />
              )}
              <SyscallPanel
                frames={frames}
                version={store.version}
                index={index}
                live={live && atEnd}
                totals={run?.syscallTotals ?? new Map()}
                threadIndex={run?.threadIndex ?? new Map()}
                selectedTid={selTid}
                enabled={!run?.start || run.start.strace}
              />
              <OutputPanel frames={frames} version={store.version} index={index} exit={run?.exit ?? null} build={run?.build ?? null} atEnd={atEnd} />
            </aside>
          </div>
          <Timeline
            frames={frames}
            version={store.version}
            index={Math.max(0, index)}
            live={live}
            nproc={info?.nproc ?? 1}
            onSeek={(i) => setCursor(i)}
            onLive={() => setCursor(null)}
          />
        </>
      )}
      {viewer && <CodeViewer path={viewer.path} lang={viewer.lang} load={viewer.load} onClose={() => setViewer(null)} />}
    </div>
  );
}
