import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";

export type ThreadNodeData = {
  label: string;
  hue: number;
  state: string;
  oncpu: number;
  migrated: boolean;
  selected: boolean;
  title: string;
};
export type ThreadNodeType = Node<ThreadNodeData, "thread">;

export const CHIP_W = 44;
export const CHIP_H = 22;

function ThreadNode({ data }: NodeProps<ThreadNodeType>) {
  const light = 22 + data.oncpu * 30;
  const cls = ["thread-chip", `st-${data.state === "t" ? "traced" : data.state}`];
  if (data.migrated) cls.push("migrated");
  if (data.selected) cls.push("selected");
  return (
    <div
      className={cls.join(" ")}
      title={data.title}
      style={{ width: CHIP_W, height: CHIP_H, background: `hsl(${data.hue} 60% ${light}%)` }}
    >
      <span>{data.label}</span>
      <div className="chip-bar" style={{ width: `${Math.round(data.oncpu * 100)}%` }} />
    </div>
  );
}

export default memo(ThreadNode);
