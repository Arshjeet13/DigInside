import type { CacheRequest, CacheResponse, CacheSource, HardwareCache } from "./types";

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

export const fetchSources = () =>
  fetch("/api/cache/sources").then((r) => json<{ sources: CacheSource[] }>(r)).then((d) => d.sources);

export const fetchHardware = () =>
  fetch("/api/cache/hardware").then((r) => json<{ caches: HardwareCache[] }>(r)).then((d) => d.caches);

export const fetchSource = (origin: string, file: string) =>
  fetch(`/api/cache/source?origin=${encodeURIComponent(origin)}&file=${encodeURIComponent(file)}`)
    .then((r) => json<{ content: string }>(r))
    .then((d) => d.content);

export const runCache = (req: CacheRequest) =>
  fetch("/run_cache", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  }).then((r) => json<CacheResponse>(r));
