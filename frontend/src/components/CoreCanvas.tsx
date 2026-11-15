import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import CoreNode, { CORE_H, CORE_W, type CoreNodeType } from "./CoreNode";
import ThreadNode, { CHIP_H, CHIP_W, type ThreadNodeType } from "./ThreadNode";
import ProgramNode, { type ProgramNodeData, type ProgramNodeType } from "./ProgramNode";
import PinEdge, { type PinEdgeType } from "./PinEdge";
import { CanvasContext, type CanvasApi } from "./canvasContext";
import { FILE_DRAG_TYPE } from "./FileSidebar";
import BuildDialog from "./BuildDialog";
import CacheModuleNode, { type CacheModuleData } from "./CacheModuleNode";
import CacheInspector from "./CacheInspector";
import type { CachePreset, CacheRun } from "./canvasContext";
import { fetchHardware, runCache } from "../cache/api";
import type { HardwareCache } from "../cache/types";
import { fmtBytes } from "../cache/state";
import type { WorkspaceFile } from "../api";
import type { RunSession, RunStore } from "../system/runs";
import type { ThreadSample, TickMsg } from "../system/types";

const nodeTypes = { core: CoreNode, thread: ThreadNode, program: ProgramNode, cache: CacheModuleNode };
const edgeTypes = { pin: PinEdge };
const GAP_X = 40;
const GAP_Y = 24;
const SLOT_COLS = 4;
const SLOT_ROWS = 3;
const SLOT_X0 = 8;
const SLOT_Y0 = 62;
const SLOT_GAP = 4;
const STORAGE_KEY = "diginside.canvas.v1";

export const HUES = [200, 30, 140, 280, 350, 60, 170, 250];

const DEFAULT_ARGS: Record<string, string> = {
  "threads.cpp": "4 3 spin",
  "gil.py": "4",
  "syscalls.cpp": "64 3",
  "pingpong.cpp": "200000",
  "matmul.cpp": "2000 8",
};

const STATE_NAMES: Record<string, string> = {
  R: "running/runnable", S: "sleeping", D: "uninterruptible (I/O)", t: "stopped by tracer",
  T: "stopped", Z: "zombie", I: "idle",
};

function threadTitle(run: RunSession, t: ThreadSample, idx: number): string {
  return [
    `${run.meta.label} · T${idx}  tid ${t.tid}  pid ${t.pid}  (${t.comm})`,
    `state ${t.state} – ${STATE_NAMES[t.state] ?? "?"}`,
    `last CPU ${t.cpu}${t.migrated ? " (just migrated)" : ""} · allowed CPUs ${t.allowed || "?"}`,
    `on-CPU ${Math.round(t.oncpu * 100)}% · waiting for CPU ${Math.round(t.runq * 100)}%`,
    `user ${t.utime_ms.toFixed(0)} ms · kernel ${t.stime_ms.toFixed(0)} ms`,
    `ctx switches: voluntary ${t.vcs}, involuntary ${t.nvcs}`,
    `page faults: minor ${t.minflt}, major ${t.majflt}`,
  ].join("\n");
}

const PROGRAM_COLUMN = 340; // empty space left of the CPU grid for program nodes

function gridPos(i: number, cols: number) {
  return { x: PROGRAM_COLUMN + (i % cols) * (CORE_W + GAP_X), y: Math.floor(i / cols) * (CORE_H + GAP_Y) };
}

type Saved = {
  cores?: Record<string, { x: number; y: number }>;
  // program and module nodes (type defaults to "program" for layouts saved before modules existed)
  programs?: { id: string; type?: string; position: { x: number; y: number }; data: ProgramNodeData | CacheModuleData }[];
  edges?: { id: string; source: string; target: string }[];
};

function loadSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function initialState(cpus: number[]): { nodes: Node[]; edges: Edge[] } {
  const saved = loadSaved();
  const cols = Math.ceil(Math.sqrt(cpus.length));
  const nodes: Node[] = cpus.map((cpu, i) => ({
    id: `cpu-${cpu}`,
    type: "core",
    position: saved.cores?.[`cpu-${cpu}`] ?? gridPos(i, cols),
    data: { cpu },
    deletable: false,
    width: CORE_W,
    height: CORE_H,
  }));
  for (const p of saved.programs ?? []) {
    nodes.push({ id: p.id, type: p.type ?? "program", position: p.position, data: p.data });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = (saved.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

interface Props {
  cpus: number[];
  store: RunStore;
  focusedKey: string | null;
  focusedIndex: number; // frame index shown for the focused run
  selected: { key: string; tid: number } | null;
  onSelectThread: (key: string, tid: number | null) => void;
  onFocus: (key: string) => void;
  onRunStarted: (key: string) => void;
  openCode: (path: string, lang: WorkspaceFile["lang"]) => void;
}

/**
 * The shared canvas: movable CPU nodes, program nodes dropped from the file sidebar,
 * program→CPU edges (= CPU pinning), and live thread chips sitting on their last CPU.
 */
export default function CoreCanvas(props: Props) {
  const { cpus, store, focusedKey, focusedIndex, selected, onSelectThread, onFocus, onRunStarted, openCode } = props;
  const init = useMemo(() => initialState(cpus), [cpus]);
  const [nodes, setNodes] = useState<Node[]>(init.nodes);
  const [edges, setEdges] = useState<Edge[]>(init.edges);
  const { screenToFlowPosition } = useReactFlow();
  const lastPin = useRef(new Map<string, string>()); // program id -> cpus last sent to its run

  // ---- persistence
  useEffect(() => {
    const t = setTimeout(() => {
      const saved: Saved = {
        cores: Object.fromEntries(nodes.filter((n) => n.type === "core").map((n) => [n.id, n.position])),
        programs: nodes
          .filter((n) => n.type === "program" || n.type === "cache")
          .map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as ProgramNodeData | CacheModuleData })),
        edges: edges.map(({ id, source, target }) => ({ id, source, target })),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch {
        /* storage unavailable */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  // ---- pinning = edges from a program node to CPU nodes
  const pinnedFor = useCallback(
    (id: string) =>
      edges
        .filter((e) => e.source === id && e.target.startsWith("cpu-"))
        .map((e) => Number(e.target.slice(4)))
        .sort((a, b) => a - b),
    [edges],
  );

  // Re-pin running programs when their edges change.
  useEffect(() => {
    for (const n of nodes) {
      if (n.type !== "program") continue;
      const run = store.get(n.id);
      if (!run || run.status !== "running") continue;
      const want = pinnedFor(n.id).join(",");
      if (lastPin.current.get(n.id) !== want) {
        lastPin.current.set(n.id, want);
        run.pin(pinnedFor(n.id));
      }
    }
  }, [edges, nodes, store, store.version, pinnedFor]);

  // ---- cache modules: program -> cache edges feed the program's memory trace into the cache
  const [cacheRuns, setCacheRuns] = useState<Record<string, CacheRun>>({});
  const cacheReq = useRef(new Map<string, number>());
  const [hardware, setHardware] = useState<HardwareCache[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  useEffect(() => {
    fetchHardware().then(setHardware).catch(() => setHardware([]));
  }, []);

  const geoKey = (g: { s: number; E: number; b: number }) => `${g.s}-${g.E}-${g.b}`;

  const traceInto = useCallback(
    async (cacheId: string, program: { file: string; args: string }, g: { s: number; E: number; b: number }) => {
      const req = (cacheReq.current.get(cacheId) ?? 0) + 1;
      cacheReq.current.set(cacheId, req);
      setCacheRuns((r) => ({ ...r, [cacheId]: { ...(r[cacheId] ?? { cursor: 0 }), status: "tracing", program, error: undefined } }));
      try {
        const resp = await runCache({ origin: "workspace", file: program.file, args: program.args, s: g.s, E: g.E, b: g.b });
        if (cacheReq.current.get(cacheId) !== req) return;
        setCacheRuns((r) => {
          const prev = r[cacheId];
          if (!resp.ok || !resp.sim) {
            const why = resp.stage === "build"
              ? `compile failed: ${resp.build.output.trim().split("\n").slice(-1)[0] ?? ""}`
              : resp.error ?? "run failed";
            return { ...r, [cacheId]: { status: "error", error: why, program, cursor: 0 } };
          }
          const n = resp.sim.events.n;
          const sameTrace = prev?.resp && prev.program?.file === program.file && prev.program?.args === program.args;
          return { ...r, [cacheId]: { status: "ready", resp, program, geoKey: geoKey(g), cursor: sameTrace ? Math.min(prev.cursor, n) : n } };
        });
      } catch (err) {
        if (cacheReq.current.get(cacheId) !== req) return;
        setCacheRuns((r) => ({ ...r, [cacheId]: { status: "error", error: (err as Error).message, program, cursor: 0 } }));
      }
    },
    [],
  );

  const cacheProgram = useCallback(
    (cacheId: string) => {
      const e = edges.find((x) => x.target === cacheId && x.source.startsWith("p-"));
      const n = e ? nodes.find((x) => x.id === e.source) : undefined;
      if (!n) return null;
      const d = n.data as ProgramNodeData;
      return { nodeId: n.id, file: d.file, traced: d.traced };
    },
    [edges, nodes],
  );

  const updateCache = useCallback((id: string, patch: Partial<CacheModuleData>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }, []);

  // Geometry changed after a run: re-simulate the same (cached) trace.
  useEffect(() => {
    const timers: number[] = [];
    for (const n of nodes) {
      if (n.type !== "cache") continue;
      const d = n.data as CacheModuleData;
      const run = cacheRuns[n.id];
      if (run?.program && run.status === "ready" && run.geoKey !== geoKey(d) && 2 ** d.s * d.E <= 2048) {
        timers.push(window.setTimeout(() => traceInto(n.id, run.program!, d), 300));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [nodes, cacheRuns, traceInto]);

  const cachePresets = useCallback(
    (cacheId: string): CachePreset[] => {
      const out: CachePreset[] = [];
      const prog = cacheProgram(cacheId);
      const hint = prog ? (nodes.find((x) => x.id === prog.nodeId)?.data as ProgramNodeData | undefined)?.cacheHint : undefined;
      if (hint && prog) out.push({ label: `Suggested for ${prog.file}`, g: hint });
      for (const h of hardware) {
        out.push({
          label: `Your CPU's ${h.name}: ${fmtBytes(h.size)}, ${h.ways}-way, ${h.line} B`,
          g: { s: h.s, E: h.E, b: h.b },
          disabled: !h.fits,
          title: h.fits ? "Real geometry from Linux; the simulator uses ideal LRU and no prefetching" : `Too big to draw: ${h.why}`,
        });
      }
      out.push(
        { label: "1 KB direct-mapped, 32 B blocks", g: { s: 5, E: 1, b: 5 } },
        { label: "1 KB 2-way, 32 B blocks", g: { s: 4, E: 2, b: 5 } },
        { label: "1 KB fully associative", g: { s: 0, E: 32, b: 5 } },
        { label: "Tiny: 4 sets, direct-mapped, 16 B", g: { s: 2, E: 1, b: 4 } },
      );
      return out;
    },
    [cacheProgram, nodes, hardware],
  );

  const runProgram = useCallback(
    (id: string) => {
      const n = nodes.find((x) => x.id === id);
      if (!n || n.type !== "program") return;
      const d = n.data as ProgramNodeData;
      const cpusPinned = pinnedFor(id);
      lastPin.current.set(id, cpusPinned.join(","));
      store.startRun(
        { key: id, label: d.file, hue: d.hue },
        { file: d.file, args: d.args, strace: d.strace, cpus: cpusPinned, build: d.build || undefined },
      );
      // ...and trace its memory accesses into every cache module it's connected to.
      for (const e of edges) {
        if (e.source !== id || !e.target.startsWith("cache-")) continue;
        const c = nodes.find((x) => x.id === e.target);
        if (c) traceInto(c.id, { file: d.file, args: d.args }, c.data as CacheModuleData);
      }
      onRunStarted(id);
    },
    [nodes, edges, pinnedFor, store, onRunStarted, traceInto],
  );

  const updateProgram = useCallback((id: string, patch: Partial<ProgramNodeData>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }, []);
  const [buildEditing, setBuildEditing] = useState<string | null>(null);
  // Removing a program's edges unpins it; the re-pin effect above applies it live if it's running.
  const unpinAll = useCallback(
    (id: string) => setEdges((es) => es.filter((e) => !(e.source === id && e.target.startsWith("cpu-")))),
    [],
  );

  const api: CanvasApi = useMemo(
    () => ({
      version: store.version,
      getRun: store.get,
      pinnedFor,
      runProgram,
      stopProgram: store.stopRun,
      updateProgram,
      editBuild: setBuildEditing,
      unpinAll,
      getCacheRun: (id: string) => cacheRuns[id],
      cacheProgram,
      updateCache,
      inspectCache: setInspecting,
      cachePresets,
      openCode,
      focusedKey,
    }),
    [store.version, store.get, store.stopRun, pinnedFor, runProgram, updateProgram, unpinAll, openCode, focusedKey,
      cacheRuns, cacheProgram, updateCache, cachePresets],
  );

  // ---- React Flow change handlers (thread chips are derived, never stored)
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const mine = changes.filter((c) => !("id" in c) || !String(c.id).startsWith("t|"));
      for (const c of mine) {
        if (c.type !== "remove") continue;
        if (c.id.startsWith("cache-")) {
          setCacheRuns((r) => {
            const { [c.id]: _gone, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
            return rest;
          });
          setInspecting((x) => (x === c.id ? null : x));
        } else store.removeRun(c.id);
      }
      setNodes((ns) => applyNodeChanges(mine, ns));
    },
    [store],
  );
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);
  const isValidConnection: IsValidConnection = useCallback(
    (c) => c.source.startsWith("p-") && (c.target.startsWith("cpu-") || c.target.startsWith("cache-")),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      if (c.target.startsWith("cache-")) {
        // A cache simulates one program's trace: a new connection replaces the old one. If the cache
        // hasn't run yet, adopt the program's suggested geometry.
        const prog = nodes.find((n) => n.id === c.source)?.data as ProgramNodeData | undefined;
        if (prog?.cacheHint && !cacheRuns[c.target]) updateCache(c.target, prog.cacheHint);
        setEdges((es) => addEdge({ ...c, id: `e|${c.source}|${c.target}` }, es.filter((e) => e.target !== c.target)));
      } else {
        setEdges((es) => addEdge({ ...c, id: `e|${c.source}|${c.target}` }, es));
      }
    },
    [nodes, cacheRuns, updateCache],
  );

  // ---- module palette
  const wrapper = useRef<HTMLDivElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const addCache = () => {
    const r = wrapper.current?.getBoundingClientRect();
    const pos = r ? screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    setNodes((ns) => {
      const count = ns.filter((n) => n.type === "cache").length;
      return [
        ...ns,
        {
          id: `cache-${Date.now().toString(36)}`,
          type: "cache",
          position: { x: pos.x - 145, y: pos.y - 120 },
          data: { name: `Cache ${count + 1}`, s: 5, E: 1, b: 5 } satisfies CacheModuleData,
        },
      ];
    });
    setPaletteOpen(false);
  };

  // ---- drop a file from the sidebar to create a program node
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(FILE_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(FILE_DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      const f = JSON.parse(raw) as WorkspaceFile;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setNodes((ns) => {
        const count = ns.filter((n) => n.type === "program").length;
        const node: ProgramNodeType = {
          id: `p-${Date.now().toString(36)}`,
          type: "program",
          position: { x: pos.x - 120, y: pos.y - 20 },
          data: {
            file: f.path,
            lang: f.lang,
            args: f.args ?? DEFAULT_ARGS[f.path] ?? "",
            strace: true,
            traced: f.traced,
            cacheHint: f.cache ?? undefined,
            build: f.build ?? undefined,
            defaultBuild: f.build ?? undefined,
            hue: HUES[count % HUES.length],
          },
        };
        return [...ns, node];
      });
    },
    [screenToFlowPosition],
  );

  // ---- live overlay: thread chips + per-core load
  const sessions = store.all();
  const shown: { run: RunSession; tick: TickMsg }[] = [];
  for (const run of sessions) {
    if (!run.frames.length) continue;
    if (run.meta.key === focusedKey) {
      const i = Math.min(Math.max(0, focusedIndex), run.frames.length - 1);
      shown.push({ run, tick: run.frames[i].tick });
    } else if (run.status === "running") {
      shown.push({ run, tick: run.frames[run.frames.length - 1].tick });
    }
  }
  const coreLoad = new Map((shown.find((s) => s.run.meta.key === focusedKey) ?? shown[0])?.tick.cores.map((c) => [c.cpu, c]) ?? []);

  const renderedNodes: Node[] = [];
  const chips: ThreadNodeType[] = [];
  const byCore = new Map<number, { run: RunSession; t: ThreadSample }[]>();
  for (const { run, tick } of shown) {
    for (const t of tick.threads) {
      const l = byCore.get(t.cpu) ?? [];
      l.push({ run, t });
      byCore.set(t.cpu, l);
    }
  }
  const pinCount = new Map<string, number>();
  for (const e of edges) pinCount.set(e.target, (pinCount.get(e.target) ?? 0) + 1);
  const slots = SLOT_COLS * SLOT_ROWS;

  for (const n of nodes) {
    if (n.type !== "core") {
      renderedNodes.push(n);
      continue;
    }
    const cpu = (n.data as CoreNodeType["data"]).cpu;
    const list = (byCore.get(cpu) ?? []).sort(
      (a, b) =>
        a.run.meta.key.localeCompare(b.run.meta.key) ||
        (a.run.threadIndex.get(a.t.tid) ?? 0) - (b.run.threadIndex.get(b.t.tid) ?? 0),
    );
    const load = coreLoad.get(cpu);
    renderedNodes.push({
      ...n,
      data: {
        cpu,
        user: load?.user ?? 0,
        kernel: load?.kernel ?? 0,
        ours: list.reduce((a, x) => a + x.t.oncpu, 0),
        hidden: Math.max(0, list.length - slots),
        pinnedBy: pinCount.get(n.id) ?? 0,
      },
    });
    list.forEach(({ run, t }, i) => {
      const idx = run.threadIndex.get(t.tid) ?? 0;
      chips.push({
        id: `t|${run.meta.key}|${t.tid}`,
        type: "thread",
        position: {
          x: n.position.x + SLOT_X0 + (i % SLOT_COLS) * (CHIP_W + SLOT_GAP),
          y: n.position.y + SLOT_Y0 + Math.floor(i / SLOT_COLS) * (CHIP_H + SLOT_GAP),
        },
        width: CHIP_W,
        height: CHIP_H,
        hidden: i >= slots,
        zIndex: 5000,
        draggable: false,
        selectable: false,
        deletable: false,
        data: {
          label: `T${idx}`,
          hue: run.meta.hue,
          state: t.state,
          oncpu: t.oncpu,
          migrated: t.migrated,
          selected: selected?.key === run.meta.key && selected.tid === t.tid,
          title: threadTitle(run, t, idx),
        },
      });
    });
  }
  // Stable order so chip DOM elements persist and CSS transitions animate migrations.
  chips.sort((a, b) => a.id.localeCompare(b.id));

  const renderedEdges: PinEdgeType[] = edges.map((e) => {
    const src = nodes.find((n) => n.id === e.source);
    const hue = (src?.data as ProgramNodeData | undefined)?.hue ?? 200;
    const active = store.get(e.source)?.active ?? false;
    return { ...e, type: "pin", animated: active, data: { hue, kind: e.target.startsWith("cache-") ? "trace" : "pin" } };
  });

  const resetLayout = () => {
    const cols = Math.ceil(Math.sqrt(cpus.length));
    setNodes((ns) =>
      ns.map((n) => {
        if (n.type !== "core") return n;
        const i = cpus.indexOf((n.data as CoreNodeType["data"]).cpu);
        return { ...n, position: gridPos(i, cols) };
      }),
    );
  };

  return (
    <CanvasContext.Provider value={api}>
      <div className="canvas-drop" ref={wrapper} onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlow
          nodes={[...renderedNodes, ...chips]}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          elevateEdgesOnSelect
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeClick={(_, n) => {
            if (n.type === "thread") {
              const [, key, tid] = n.id.split("|");
              onSelectThread(key, Number(tid));
            } else if (n.type === "program") {
              onFocus(n.id);
            }
          }}
          onPaneClick={() => selected && onSelectThread(selected.key, null)}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          minZoom={0.15}
          colorMode="dark"
        >
          <Background />
          <Controls showInteractive={false} position="top-left" />
          <Panel position="top-right">
            <div className="palette">
              <button className="btn small run" onClick={() => setPaletteOpen((o) => !o)} title="Spawn a module onto the canvas">
                + Add module ▾
              </button>
              <button className="btn small" onClick={resetLayout} title="Put CPU nodes back in a grid">Reset CPU layout</button>
              {paletteOpen && (
                <div className="palette-menu">
                  <button onClick={addCache}>
                    <b>▦ Cache</b>
                    <span className="muted small">Set-associative cache. Connect a program that uses tarray.hpp, press Run, then step through every access.</span>
                  </button>
                </div>
              )}
            </div>
          </Panel>
        </ReactFlow>
      </div>
      {inspecting && cacheRuns[inspecting]?.resp?.sim && (
        <CacheInspector
          name={(nodes.find((x) => x.id === inspecting)?.data as CacheModuleData | undefined)?.name ?? "Cache"}
          program={cacheRuns[inspecting].program?.file ?? ""}
          resp={cacheRuns[inspecting].resp!}
          cursor={cacheRuns[inspecting].cursor}
          onCursor={(c) => setCacheRuns((r) => (r[inspecting] ? { ...r, [inspecting]: { ...r[inspecting], cursor: c } } : r))}
          onClose={() => setInspecting(null)}
        />
      )}
      {(() => {
        const n = buildEditing ? nodes.find((x) => x.id === buildEditing) : undefined;
        if (!n) return null;
        const d = n.data as ProgramNodeData;
        return (
          <BuildDialog
            file={d.file}
            lang={d.lang}
            value={d.build ?? d.defaultBuild ?? ""}
            defaultBuild={d.defaultBuild ?? ""}
            onSave={(build) => {
              updateProgram(n.id, { build });
              setBuildEditing(null);
            }}
            onClose={() => setBuildEditing(null)}
          />
        );
      })()}
    </CanvasContext.Provider>
  );
}
