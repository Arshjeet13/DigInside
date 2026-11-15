import { createContext, useContext } from "react";
import type { RunSession } from "../system/runs";
import type { WorkspaceFile } from "../api";

export interface CanvasApi {
  version: number;
  getRun: (nodeId: string) => RunSession | undefined;
  pinnedFor: (nodeId: string) => number[];
  runProgram: (nodeId: string) => void;
  stopProgram: (nodeId: string) => void;
  updateProgram: (nodeId: string, patch: Partial<{ args: string; strace: boolean; build: string }>) => void;
  editBuild: (nodeId: string) => void;
  openCode: (path: string, lang: WorkspaceFile["lang"]) => void;
  focusedKey: string | null;
}

export const CanvasContext = createContext<CanvasApi | null>(null);

export function useCanvasApi(): CanvasApi {
  const v = useContext(CanvasContext);
  if (!v) throw new Error("CanvasContext missing");
  return v;
}
