import { useEffect, useMemo, useState } from "react";
import { readFile, type WorkspaceFile } from "../api";
import { toLines, tokenize } from "./highlight";

interface Props {
  path: string;
  lang: WorkspaceFile["lang"];
  onClose: () => void;
}

export default function CodeViewer({ path, lang, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    readFile(path).then(setContent).catch((e: Error) => setError(e.message));
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = useMemo(() => (content === null ? [] : toLines(tokenize(content, lang))), [content, lang]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal code-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className={`lang-badge lang-${lang}`}>{lang}</span>
          <span className="modal-title">{path}</span>
          <span className="spacer" />
          <span className="muted small">{content !== null ? `${lines.length} lines · read-only · Esc to close` : ""}</span>
          <button className="btn small" onClick={onClose}>×</button>
        </div>
        <div className="code-body">
          {error && <div className="bad">{error}</div>}
          {content === null && !error && <div className="muted">loading…</div>}
          {content !== null && (
            <table className="code-table">
              <tbody>
                {lines.map((toks, i) => (
                  <tr key={i}>
                    <td className="ln">{i + 1}</td>
                    <td className="code-line">
                      {toks.map((t, j) => (t.t === "txt" ? t.s : <span key={j} className={`hl-${t.t}`}>{t.s}</span>))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
