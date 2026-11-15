import { useCallback, useEffect, useRef, useState } from "react";
import type { BuildMsg, ExitMsg, Frame, RunRequest, StartMsg, SystemMsg, ThreadSample } from "./types";

export type RunStatus = "connecting" | "building" | "running" | "exited" | "error";

const MAX_FRAMES = 6000; // 5 minutes at 50ms

export interface RunMeta {
  key: string; // owner: the program node id
  label: string;
  hue: number;
}

type Totals = Map<string, { n: number; time_us: number; err: number }>;

/** One WebSocket run. Plain object (not React state); the store bumps a version on change. */
export class RunSession {
  readonly meta: RunMeta;
  status: RunStatus = "connecting";
  start: StartMsg | null = null;
  exit: ExitMsg | null = null;
  error: string | null = null;
  build: BuildMsg | null = null;
  pinned: number[] | null = null;
  frames: Frame[] = [];
  threadIndex = new Map<number, number>();
  pidIndex = new Map<number, number>();
  syscallTotals: Totals = new Map();
  private lastSeen = new Map<number, ThreadSample>();
  private totalSyscalls = 0;
  private ws: WebSocket;
  private closed = false;

  constructor(meta: RunMeta, req: RunRequest, private onChange: () => void) {
    this.meta = meta;
    this.pinned = req.cpus?.length ? [...req.cpus].sort((a, b) => a - b) : null;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws/system`);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ interval_ms: 50, ...req }));
    this.ws.onmessage = (ev) => {
      if (!this.closed) this.onMsg(JSON.parse(ev.data));
    };
    this.ws.onerror = () => {
      if (this.closed) return;
      this.error = "WebSocket error — is the backend running on :8000?";
      this.status = "error";
      this.onChange();
    };
    this.ws.onclose = () => {
      if (this.closed) return;
      if (this.status === "running" || this.status === "connecting" || this.status === "building") {
        this.status = this.build && !this.build.ok ? "error" : "exited";
      }
      this.onChange();
    };
  }

  get active() {
    return this.status === "connecting" || this.status === "building" || this.status === "running";
  }

  stop() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop" }));
  }

  pin(cpus: number[]) {
    if (this.ws.readyState === WebSocket.OPEN && this.status === "running") {
      this.ws.send(JSON.stringify({ type: "pin", cpus }));
    }
  }

  /** Drop the connection without further updates (also kills the program server-side). */
  dispose() {
    this.closed = true;
    this.ws.close();
  }

  private onMsg(m: SystemMsg) {
    switch (m.type) {
      case "build":
        this.build = m;
        this.status = m.ok ? "building" : "error";
        if (!m.ok) this.error = "compile failed";
        break;
      case "start":
        this.start = m;
        this.pinned = m.cpus;
        this.status = "running";
        break;
      case "pinned":
        this.pinned = m.cpus;
        break;
      case "tick": {
        for (const t of m.threads) {
          if (!this.threadIndex.has(t.tid)) this.threadIndex.set(t.tid, this.threadIndex.size);
          if (!this.pidIndex.has(t.pid)) this.pidIndex.set(t.pid, this.pidIndex.size);
          this.lastSeen.set(t.tid, t);
        }
        if (m.syscalls) {
          this.totalSyscalls += m.syscalls.count;
          for (const [name, s] of Object.entries(m.syscalls.by_name)) {
            const cur = this.syscallTotals.get(name) ?? { n: 0, time_us: 0, err: 0 };
            cur.n += s.n;
            cur.time_us += s.time_us;
            cur.err += s.err;
            this.syscallTotals.set(name, cur);
          }
        }
        let user = 0, kernel = 0, vcs = 0, nvcs = 0;
        for (const t of this.lastSeen.values()) {
          user += t.utime_ms;
          kernel += t.stime_ms;
          vcs += t.vcs;
          nvcs += t.nvcs;
        }
        if (this.frames.length >= MAX_FRAMES) this.frames.shift();
        this.frames.push({
          tick: m,
          agg: {
            user_ms: user,
            kernel_ms: kernel,
            vcs,
            nvcs,
            syscalls: this.totalSyscalls,
            oncpu: m.threads.reduce((a, t) => a + t.oncpu, 0),
            machine: m.cores.reduce((a, c) => a + c.user + c.kernel, 0),
            alive: m.threads.length,
          },
        });
        break;
      }
      case "exit":
        this.exit = m;
        this.status = "exited";
        break;
      case "error":
        this.error = m.message;
        this.status = "error";
        break;
    }
    this.onChange();
  }
}

export interface RunStore {
  version: number;
  get: (key: string) => RunSession | undefined;
  all: () => RunSession[];
  startRun: (meta: RunMeta, req: RunRequest) => RunSession;
  stopRun: (key: string) => void;
  removeRun: (key: string) => void;
}

/** All runs, at most one per owner key. Re-renders at most once per animation frame. */
export function useRunStore(): RunStore {
  const sessions = useRef(new Map<string, RunSession>());
  const [version, setVersion] = useState(0);
  const raf = useRef<number | null>(null);

  const bump = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  const removeRun = useCallback((key: string) => {
    sessions.current.get(key)?.dispose();
    sessions.current.delete(key);
    bump();
  }, [bump]);

  const startRun = useCallback((meta: RunMeta, req: RunRequest) => {
    sessions.current.get(meta.key)?.dispose(); // one run per owner; replacing kills the old one
    const s = new RunSession(meta, req, bump);
    sessions.current.set(meta.key, s);
    bump();
    return s;
  }, [bump]);

  const stopRun = useCallback((key: string) => sessions.current.get(key)?.stop(), []);
  const get = useCallback((key: string) => sessions.current.get(key), []);
  const all = useCallback(() => [...sessions.current.values()], []);

  useEffect(() => () => {
    for (const s of sessions.current.values()) s.dispose();
  }, []);

  return { version, get, all, startRun, stopRun, removeRun };
}
