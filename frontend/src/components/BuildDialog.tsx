import { useEffect, useState } from "react";

// Same defaults as backend/workspace.py (used if a node was saved before build commands existed).
const FALLBACK: Record<string, string> = {
  cpp: "g++ -O2 -g -pthread -std=c++20 -Wall -fopenmp {src} -o {out}",
  c: "gcc -O2 -g -pthread -Wall -fopenmp {src} -o {out} -lm",
};

function presets(lang: string): { label: string; cmd: string; note?: string }[] {
  const cc = lang === "c" ? "gcc" : "g++";
  const std = lang === "c" ? "" : " -std=c++20";
  const lm = lang === "c" ? " -lm" : "";
  const base = (opt: string, extra = "") => `${cc} ${opt}${extra} -g -pthread${std} -Wall -fopenmp {src} -o {out}${lm}`;
  return [
    { label: "Default (-O2)", cmd: FALLBACK[lang] ?? base("-O2") },
    { label: "No optimization (-O0)", cmd: base("-O0"), note: "easiest to debug, much slower loops" },
    { label: "Max optimization (-O3 -march=native)", cmd: base("-O3", " -march=native"), note: "uses every instruction this CPU supports" },
    { label: "-O2 without vectorization", cmd: base("-O2", " -fno-tree-vectorize"), note: "no SIMD: compare against Default" },
    {
      label: "ThreadSanitizer (find data races)",
      cmd: `${cc} -O1 -g -fsanitize=thread -pthread${std} {src} -o {out}${lm}`,
      note: "reports races in the Output panel; runs ~5-15x slower",
    },
    {
      label: "AddressSanitizer + UBSan (strace off)",
      cmd: `${cc} -O1 -g -fsanitize=address,undefined -pthread${std} {src} -o {out}${lm}`,
      note: "finds out-of-bounds/use-after-free; its leak checker can't run under strace",
    },
  ];
}

interface Props {
  file: string;
  lang: string;
  value: string;
  defaultBuild: string;
  onSave: (build: string) => void;
  onClose: () => void;
}

export default function BuildDialog({ file, lang, value, defaultBuild, onSave, onClose }: Props) {
  const def = defaultBuild || FALLBACK[lang] || "";
  const [text, setText] = useState(value || def);
  const missing = ["{src}", "{out}"].filter((p) => !text.includes(p));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal build-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Build command · {file}</span>
          <span className="spacer" />
          <button className="btn small" onClick={onClose}>×</button>
        </div>
        <div className="build-body">
          <textarea
            className="build-text"
            value={text}
            spellCheck={false}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !missing.length) onSave(text.trim());
            }}
          />
          <div className="small muted">
            <code>{"{src}"}</code> is replaced by <code>{file}</code> and <code>{"{out}"}</code> by the binary DigInside runs.
            For gcc/g++ the include paths <code>-I workspace -I instrument</code> are added automatically. The command runs
            without a shell (no pipes or redirects). Each distinct command gets its own cached binary.
          </div>
          {missing.length > 0 && <div className="small bad">Missing {missing.join(" and ")}.</div>}
          <div className="build-presets">
            {presets(lang).map((p) => (
              <button
                key={p.label}
                className={`preset-btn${p.cmd === text.trim() ? " active" : ""}`}
                onClick={() => setText(p.cmd)}
                title={p.cmd}
              >
                <span>{p.label}</span>
                {p.note && <span className="muted small">{p.note}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn small" onClick={() => setText(def)}>Reset to default</button>
          <span className="spacer" />
          <span className="muted small">Ctrl+Enter to save</span>
          <button className="btn small" onClick={onClose}>Cancel</button>
          <button className="btn small run" disabled={missing.length > 0} onClick={() => onSave(text.trim())}>Save</button>
        </div>
      </div>
    </div>
  );
}
