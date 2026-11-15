import { useEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";

export type PinEdgeData = { hue: number };
export type PinEdgeType = Edge<PinEdgeData, "pin">;

/** Program → CPU edge (= CPU pin). Highlights when selected; hover or select shows a × to unpin. */
export default function PinEdge(props: EdgeProps<PinEdgeType>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, markerEnd } = props;
  const { deleteElements } = useReactFlow();
  const [hover, setHover] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const enter = () => {
    window.clearTimeout(leaveTimer.current);
    setHover(true);
  };
  // Small delay so the pointer can travel from the edge to the × button (which lives in another layer).
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHover(false), 400);
  };

  const hue = data?.hue ?? 200;
  const hot = selected || hover;
  return (
    <>
      <g onMouseEnter={enter} onMouseLeave={leave}>
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          interactionWidth={24}
          style={{
            stroke: selected ? "#ffffff" : `hsl(${hue} 70% ${hover ? 72 : 60}%)`,
            strokeWidth: selected ? 4 : hover ? 3 : 2,
          }}
        />
      </g>
      {hot && (
        <EdgeLabelRenderer>
          <button
            className="edge-remove nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title="Unpin (remove this edge)"
            onMouseEnter={enter}
            onMouseLeave={leave}
            onClick={(e) => {
              e.stopPropagation();
              deleteElements({ edges: [{ id }] });
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
