import { useEffect, useMemo, useRef } from "react";
import type { BuildMsg, ExitMsg, Frame } from "../system/types";

interface Props {
  frames: Frame[];
  version: number;
  index: number;
  exit: ExitMsg | null;
  build: BuildMsg | null;
  atEnd: boolean;
}

export default function OutputPanel({ frames, version, index, exit, build, atEnd }: Props) {
  const lines = useMemo(() => {
    const out: string[] = [];
    if (build?.needed) {
      out.push(`$ ${build.cmd ?? "compile"}`);
      if (build.output) out.push(...build.output.trimEnd().split("\n"));
      out.push(build.ok ? `[compiled in ${build.ms ?? 0} ms]` : "[compile failed]", "");
    }
    for (let i = 0; i <= index && i < frames.length; i++) out.push(...frames[i].tick.output.lines);
    if (atEnd && exit) out.push(...exit.output.lines);
    return out.slice(-300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, index, exit, build, atEnd, frames]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div className="panel">
      <div className="panel-title">Program output</div>
      <pre className="output" ref={ref}>{lines.length ? lines.join("\n") : <span className="muted">(none)</span>}</pre>
    </div>
  );
}
