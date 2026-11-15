import { useRef, useState } from "react";
import { deleteFile, writeFile, type WorkspaceFile } from "../api";

export const FILE_DRAG_TYPE = "application/x-diginside-file";
const ACCEPT = ".c,.cc,.cpp,.cxx,.h,.hh,.hpp,.py,.sh";

const ICON: Record<WorkspaceFile["lang"], string> = { cpp: "C++", c: "C", python: "Py", shell: "sh" };

interface Props {
  files: WorkspaceFile[];
  error: string | null;
  onRefresh: () => void;
  onOpen: (f: WorkspaceFile) => void;
}

export default function FileSidebar({ files, error, onRefresh, onOpen }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const upload = async (list: FileList | File[]) => {
    const arr = [...list];
    if (!arr.length) return;
    const failed: string[] = [];
    for (const f of arr) {
      try {
        await writeFile(f.name, await f.text());
      } catch (e) {
        failed.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    const ok = arr.length - failed.length;
    setMsg(failed.length ? { text: failed.join("\n"), bad: true } : { text: `uploaded ${ok} file${ok === 1 ? "" : "s"}`, bad: false });
    onRefresh();
  };

  const remove = async (f: WorkspaceFile) => {
    if (!confirm(`Delete ${f.path} from the workspace?`)) return;
    try {
      await deleteFile(f.path);
      setMsg(null);
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
    onRefresh();
  };

  const isOsFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <aside
      className={`files${dropping ? " dropping" : ""}`}
      onDragOver={(e) => {
        if (!isOsFileDrag(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!isOsFileDrag(e)) return;
        e.preventDefault();
        setDropping(false);
        upload(e.dataTransfer.files);
      }}
    >
      <div className="files-head">
        <span>Workspace</span>
        <span className="spacer" />
        <button className="btn small" title="Upload code files" onClick={() => input.current?.click()}>Upload</button>
        <button className="btn small" title="Refresh" onClick={onRefresh}>↻</button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <div className="files-list">
        {error && <div className="bad small">{error}</div>}
        {files.map((f) => (
          <div
            key={f.path}
            className={`file-item${f.runnable ? "" : " not-runnable"}`}
            draggable={f.runnable}
            title={f.runnable ? "Click to view · drag onto the canvas to run" : "Click to view (headers can't run on their own)"}
            onDragStart={(e) => {
              e.dataTransfer.setData(FILE_DRAG_TYPE, JSON.stringify(f));
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onOpen(f)}
          >
            <span className={`lang-badge lang-${f.lang}`}>{ICON[f.lang]}</span>
            <span className="file-name">{f.path}</span>
            <button
              className="file-del"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                remove(f);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {!error && files.length === 0 && <div className="muted small">No files yet — upload some.</div>}
      </div>
      {msg && <div className={`files-msg small ${msg.bad ? "bad" : "muted"}`}>{msg.text}</div>}
      <div className="files-hint small muted">
        Drag a file onto the canvas to make a program node, then drag from its ● handle to a CPU to pin it.
        Drop files from your computer here to upload.
      </div>
    </aside>
  );
}
