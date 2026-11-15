import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type CoreNodeData = {
  cpu: number;
  user?: number; // machine-wide user fraction on this core (0..1)
  kernel?: number; // machine-wide kernel fraction
  ours?: number; // traced programs' on-CPU fraction on this core
  hidden?: number; // threads that didn't fit in the slots
  pinnedBy?: number; // number of program nodes pinned here
};
export type CoreNodeType = Node<CoreNodeData, "core">;

export const CORE_W = 200;
export const CORE_H = 150;

function CoreNode({ data }: NodeProps<CoreNodeType>) {
  const user = data.user ?? 0;
  const kernel = data.kernel ?? 0;
  const ours = data.ours ?? 0;
  const busy = Math.min(1, user + kernel);
  const pct = (x: number) => `${Math.round(Math.min(1, x) * 100)}%`;
  return (
    <div className={`core-node${ours > 0.05 ? " core-hot" : ""}${data.pinnedBy ? " core-pinned" : ""}`} style={{ width: CORE_W, height: CORE_H }}>
      <Handle type="target" position={Position.Left} className="core-handle" title="Connect a program here to pin it to this CPU" />
      <div className="core-head">
        <span className="core-label">CPU {data.cpu}</span>
        <span className="core-pct" title="machine-wide busy on this core">{pct(busy)}</span>
      </div>
      <div className="core-bar" title={`user ${pct(user)} · kernel ${pct(kernel)} (whole machine)`}>
        <div className="seg-user" style={{ width: pct(user) }} />
        <div className="seg-kernel" style={{ width: pct(Math.min(kernel, 1 - Math.min(1, user))) }} />
      </div>
      <div className="core-ours" title="share of this core used by traced programs">
        ours {pct(ours)}
        {(data.hidden ?? 0) > 0 && <span className="core-more">+{data.hidden} more</span>}
      </div>
    </div>
  );
}

export default memo(CoreNode);
