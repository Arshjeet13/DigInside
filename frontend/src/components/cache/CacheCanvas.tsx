import { memo, useMemo } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import type { SimResult } from "../../cache/types";
import {
  blockAddr, describeAddr, fmtBytes, hex, regionIndex, REGION_COLORS, RESULT_COLOR, RESULT_LABEL, type CacheState,
} from "../../cache/state";
import CacheGrid, { gridSize } from "./CacheGrid";

type D = { sim: SimResult; state: CacheState; current: number };

function CpuNode({ data }: NodeProps<Node<D>>) {
  const { sim, current } = data;
  const ev = sim.events;
  if (current < 0) {
    return (
      <div className="cc-node cpu-node">
        <div className="cc-title">CPU</div>
        <div className="muted small">press ▶ or → to step through accesses</div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  const op = ev.op[current] ? "W" : "R";
  const addr = ev.addr[current];
  const res = ev.result[current];
  const ri = regionIndex(sim.regions, addr);
  return (
    <div className="cc-node cpu-node">
      <div className="cc-title">CPU</div>
      <div className="cpu-access">
        <span className={`cpu-op op-${op}`}>{op === "R" ? "load" : "store"}</span>
        <span className="cpu-target" style={{ color: ri >= 0 ? REGION_COLORS[ri % REGION_COLORS.length] : undefined }}>
          {describeAddr(sim.regions, addr)}
        </span>
      </div>
      <div className="mono small muted">{hex(addr)}</div>
      <div className="cpu-result" style={{ background: RESULT_COLOR[res] }}>{RESULT_LABEL[res]}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function CacheNode({ data }: NodeProps<Node<D>>) {
  const { sim, state, current } = data;
  const g = sim.geometry;
  return (
    <div className="cc-node cache-node">
      <Handle type="target" position={Position.Left} />
      <div className="cc-title">
        Cache · {fmtBytes(g.size)} · S={g.S} × E={g.E} × B={g.B}
      </div>
      <CacheGrid sim={sim} state={state} current={current} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function MemoryNode({ data }: NodeProps<Node<D>>) {
  const { sim, state, current } = data;
  const { s, b, B, E } = sim.geometry;
  const resident = new Map<number, number>();
  for (let i = 0; i < state.tags.length; i++) {
    const t = state.tags[i];
    if (t < 0) continue;
    const r = regionIndex(sim.regions, blockAddr(t, Math.floor(i / E), s, b));
    resident.set(r, (resident.get(r) ?? 0) + 1);
  }
  const curAddr = current >= 0 ? sim.events.addr[current] : -1;
  return (
    <div className="cc-node mem-node">
      <Handle type="target" position={Position.Left} />
      <div className="cc-title">Memory (traced arrays)</div>
      {sim.regions.map((g, r) => {
        const blocks = Math.ceil(g.bytes / B);
        const color = REGION_COLORS[r % REGION_COLORS.length];
        const inThis = curAddr >= g.base && curAddr < g.base + g.bytes;
        const pos = inThis ? ((curAddr - g.base) / g.bytes) * 100 : -1;
        return (
          <div key={g.name + r} className="mem-region">
            <div className="mem-head">
              <span style={{ color }}>■ {g.name}</span>
              <span className="muted small">{fmtBytes(g.bytes)} @ {hex(g.base)}</span>
            </div>
            <div className="mem-bar" style={{ borderColor: color }}>
              {inThis && <div className="mem-cursor" style={{ left: `${pos}%` }} />}
            </div>
            <div className="muted small">
              in cache: {resident.get(r) ?? 0} / {blocks} blocks
            </div>
          </div>
        );
      })}
      {sim.regions.length === 0 && <div className="muted small">no named arrays in this trace</div>}
    </div>
  );
}

const nodeTypes = { cpu: memo(CpuNode), cache: memo(CacheNode), mem: memo(MemoryNode) };

interface Props {
  sim: SimResult;
  state: CacheState;
  current: number;
}

export default function CacheCanvas({ sim, state, current }: Props) {
  const g = sim.geometry;
  const size = gridSize(g.S, g.E);
  const cacheW = Math.max(size.width, 330) + 24; // the title line is wider than a narrow grid
  const nodes: Node<D>[] = useMemo(() => {
    const data = { sim, state, current };
    return [
      { id: "cpu", type: "cpu", position: { x: 0, y: 40 }, data, draggable: false },
      { id: "cache", type: "cache", position: { x: 260, y: 0 }, data, draggable: false },
      { id: "mem", type: "mem", position: { x: 260 + cacheW + 100, y: 20 }, data, draggable: false },
    ];
  }, [sim, state, current, cacheW]);

  const ev = sim.events;
  const res = current >= 0 ? ev.result[current] : -1;
  const miss = res > 0;
  const wb = current >= 0 && ev.wb[current] === 1;
  const edges: Edge[] = [
    {
      id: "cpu-cache", source: "cpu", target: "cache", animated: current >= 0,
      label: current >= 0 ? (ev.op[current] ? "store" : "load") : undefined,
      style: { stroke: res >= 0 ? RESULT_COLOR[res] : "#555d6b", strokeWidth: 2 },
    },
    {
      id: "cache-mem", source: "cache", target: "mem", animated: miss,
      label: miss ? (wb ? `fetch block + write back dirty victim` : "fetch block") : "(hit: memory not touched)",
      style: { stroke: miss ? (wb ? "#d29922" : RESULT_COLOR[res]) : "#3a4150", strokeWidth: miss ? 3 : 1.5, strokeDasharray: miss ? undefined : "4 4" },
    },
  ];

  return (
    <ReactFlow
      key={`${g.s}-${g.E}-${g.b}-${sim.events.n}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.08 }}
      minZoom={0.1}
      nodesConnectable={false}
      nodesDraggable={false}
      colorMode="dark"
    >
      <Background />
      <Controls showInteractive={false} position="top-left" />
    </ReactFlow>
  );
}
