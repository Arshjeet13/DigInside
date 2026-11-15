import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { WorkspaceFile } from "../api";
import { useCanvasApi } from "./canvasContext";
import type { RunSession } from "../system/runs";

export type ProgramNodeData = {
  file: string;
  lang: WorkspaceFile["lang"];
  args: string;
  strace: boolean;
  hue: number;
  build?: string; // build command template (C/C++); undefined = server default
  defaultBuild?: string;
  traced?: boolean; // uses tarray.hpp (can feed a Cache module)
  cacheHint?: { s: number; E: number; b: number }; // suggested cache geometry from the file header
};
export type ProgramNodeType = Node<ProgramNodeData, "program">;

export const PROGRAM_W = 270;

function statusLine(run: RunSession | undefined): [string, string] {
  if (!run) return ["ready", "muted"];
  const last = run.frames[run.frames.length - 1];
  switch (run.status) {
    case "connecting":
      return [run.meta.label.match(/\.(c|cc|cpp|cxx)$/) ? "compiling…" : "starting…", "warn"];
    case "building":
      return ["starting…", "warn"];
    case "running":
      return [`running ${last ? last.tick.t.toFixed(1) : "0.0"}s · ${last ? last.agg.oncpu.toFixed(2) : "0"} cores`, "ok"];
    case "exited": {
      const e = run.exit;
      if (!e) return ["disconnected", "warn"];
      if (e.killed) return [`stopped after ${e.wall_s.toFixed(2)}s`, "warn"];
      if (e.signal) return [`killed by ${e.signal}`, "bad"];
      return [`exit ${e.code} · ${e.wall_s.toFixed(2)}s`, e.code === 0 ? "ok" : "bad"];
    }
    case "error":
      return [run.build && !run.build.ok ? "compile error — see Output" : run.error ?? "error", "bad"];
  }
}

export default function ProgramNode({ id, data, selected }: NodeProps<ProgramNodeType>) {
  const api = useCanvasApi();
  const run = api.getRun(id);
  const active = run?.active ?? false;
  const pinned = api.pinnedFor(id);
  const [text, cls] = statusLine(run);
  const focused = api.focusedKey === id;

  return (
    <div
      className={`program-node${selected ? " selected" : ""}${focused ? " focused" : ""}${active ? " active" : ""}`}
      style={{ width: PROGRAM_W, borderColor: `hsl(${data.hue} 70% ${active ? 60 : 40}%)` }}
    >
      <div className="prog-head" style={{ background: `hsl(${data.hue} 50% 22%)` }}>
        <span className={`lang-badge lang-${data.lang}`}>{data.lang}</span>
        <span className="prog-file" title={data.file}>{data.file}</span>
        <button className="btn small nodrag" title="View code" onClick={() => api.openCode(data.file, data.lang)}>{"</>"}</button>
      </div>
      <div className="prog-body">
        <label className="prog-args">
          <span className="muted">args</span>
          <input
            className="nodrag"
            value={data.args}
            spellCheck={false}
            placeholder="(none)"
            onChange={(e) => api.updateProgram(id, { args: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !active && api.runProgram(id)}
          />
        </label>
        {(data.lang === "cpp" || data.lang === "c") && (
          <div className="prog-build">
            <span className="muted">build</span>
            <code title={data.build ?? data.defaultBuild ?? "default"}>{data.build ?? data.defaultBuild ?? "(default)"}</code>
            {data.build && data.defaultBuild && data.build !== data.defaultBuild && <span className="warn" title="custom build command">●</span>}
            <button className="btn small nodrag" disabled={active} onClick={() => api.editBuild(id)} title="Edit the compile command">edit</button>
          </div>
        )}
        <div className="prog-row">
          <label className="check nodrag" title="Trace syscalls with strace">
            <input
              type="checkbox"
              checked={data.strace}
              disabled={active}
              onChange={(e) => api.updateProgram(id, { strace: e.target.checked })}
            />
            strace
          </label>
          <span className="spacer" />
          {active ? (
            <button className="btn small stop nodrag" onClick={() => api.stopProgram(id)}>Stop</button>
          ) : (
            <button className="btn small run nodrag" onClick={() => api.runProgram(id)}>Run</button>
          )}
        </div>
        <div className="prog-pin" title="Drag from the ● handle to CPU nodes to pin; select an edge and press Delete to unpin">
          <span className="prog-pin-text">
            {pinned.length ? `pinned to CPU ${pinned.join(", ")}` : "any CPU (not pinned)"}
            {active && run?.pinned && pinned.join() !== run.pinned.join() && <span className="warn"> · applying…</span>}
          </span>
          {pinned.length > 0 && (
            <button
              className="btn small nodrag"
              title={`Remove all ${pinned.length} pin edge${pinned.length === 1 ? "" : "s"} from this program`}
              onClick={() => api.unpinAll(id)}
            >
              unpin all
            </button>
          )}
        </div>
        <div className={`prog-status ${cls}`}>{text}</div>
      </div>
      <Handle type="source" position={Position.Right} className="prog-handle" title="Drag to a CPU to pin" />
    </div>
  );
}
