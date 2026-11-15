import { createContext, useContext } from "react";
import type { RunSession } from "../system/runs";
import type { CacheResponse } from "../cache/types";

export interface CacheRun {
  status: "idle" | "tracing" | "ready" | "error";
  resp?: CacheResponse;
  error?: string;
  program?: { file: string; args: string; build?: string; traced?: boolean };
  geoKey?: string;
  cursor: number;
}

export interface CachePreset {
  label: string;
  g: { s: number; E: number; b: number };
  disabled?: boolean;
  title?: string;
}
import type { WorkspaceFile } from "../api";

export interface CanvasApi {
  version: number;
  getRun: (nodeId: string) => RunSession | undefined;
  pinnedFor: (nodeId: string) => number[];
  runProgram: (nodeId: string) => void;
  stopProgram: (nodeId: string) => void;
  updateProgram: (nodeId: string, patch: Partial<{ args: string; strace: boolean; build: string }>) => void;
  editBuild: (nodeId: string) => void;
  unpinAll: (nodeId: string) => void;
  getCacheRun: (cacheId: string) => CacheRun | undefined;
  cacheProgram: (cacheId: string) => { nodeId: string; file: string; traced?: boolean } | null;
  updateCache: (
    cacheId: string,
    patch: Partial<{ s: number; E: number; b: number; name: string; tracer: "auto" | "tarray" | "valgrind"; scope: "code" | "all" }>,
  ) => void;
  inspectCache: (cacheId: string) => void;
  cachePresets: (cacheId: string) => CachePreset[];
  openCode: (path: string, lang: WorkspaceFile["lang"]) => void;
  focusedKey: string | null;
}

export const CanvasContext = createContext<CanvasApi | null>(null);

export function useCanvasApi(): CanvasApi {
  const v = useContext(CanvasContext);
  if (!v) throw new Error("CanvasContext missing");
  return v;
}
