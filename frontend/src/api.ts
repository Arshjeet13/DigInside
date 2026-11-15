export interface MachineInfo {
  nproc: number;
  cpus: number[];
  kernel: string;
  machine: string;
}

export interface WorkspaceFile {
  path: string;
  lang: "cpp" | "c" | "python" | "shell";
  runnable: boolean;
  size: number;
  mtime: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const fetchInfo = () => fetch("/api/info").then((r) => json<MachineInfo>(r));

export const listFiles = () =>
  fetch("/api/files").then((r) => json<{ files: WorkspaceFile[] }>(r)).then((d) => d.files);

export const readFile = (path: string) =>
  fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => json<{ content: string }>(r)).then((d) => d.content);

export const writeFile = (path: string, content: string) =>
  fetch("/api/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  }).then((r) => json<{ path: string }>(r));

export const deleteFile = (path: string) =>
  fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then((r) => json(r));
