// ---------------------------------------------------------------------------
// Typed client for the Flask API.
// ---------------------------------------------------------------------------

import type { LangCode } from "./detection";

export interface BatchItem {
  id: string;
  text: string;
  from: LangCode;
  to: LangCode;
  /** True to bypass server caches and force a fresh upstream call. */
  noCache?: boolean;
}

export interface BatchResultOk {
  id: string;
  ok: true;
  translated: string;
  from: LangCode;
  to: LangCode;
  provider: string;
  cacheHits: number;
}

export interface BatchResultError {
  id: string;
  ok: false;
  error: { code: string; message: string };
}

export type BatchResult = BatchResultOk | BatchResultError;

export interface DetectResult {
  lang: LangCode;
  confidence: number;
  script: string;
  analyzedChars: number;
}

export interface HealthInfo {
  status: string;
  providers: Array<{
    name: string;
    healthy: boolean;
    latencyMs: number;
    consecutiveFailures: number;
  }>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// One network wave of a translation may legitimately take a while when the
// free upstreams are slow; keep it generous but bounded per request.
const REQUEST_TIMEOUT_MS = 60_000;

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON response */
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)
        ?.error;
      throw new ApiError(
        res.status,
        err?.code ?? "HTTP_ERROR",
        err?.message ?? `HTTP ${res.status}`
      );
    }
    return body as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(0, "TIMEOUT", "请求超时，请检查网络后重试");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface Api {
  translateBatch(items: BatchItem[], signal?: AbortSignal): Promise<BatchResult[]>;
  detect(text: string): Promise<DetectResult>;
  health(): Promise<HealthInfo>;
  /** Incremental per-document segment sync (live editor). */
  syncDocSegments(
    doc: string,
    from: LangCode,
    to: LangCode,
    items: Array<{ sid: number; text: string }>,
    alive: number[],
    signal?: AbortSignal
  ): Promise<SegSyncResult[]>;
}

export interface SegSyncResult {
  sid: number;
  ok: boolean;
  translated?: string;
  provider?: string;
  cache?: boolean;
  error?: { code: string; message: string };
}

export function createApi(basePath = "/api"): Api {
  return {
    async translateBatch(items, signal): Promise<BatchResult[]> {
      const payload = await request<{ results: BatchResult[] }>(
        `${basePath}/translate/batch`,
        { method: "POST", body: JSON.stringify({ items }), signal }
      );
      return payload.results;
    },
    async syncDocSegments(doc, from, to, items, alive, signal): Promise<SegSyncResult[]> {
      const payload = await request<{ results: SegSyncResult[] }>(
        `${basePath}/docs/${encodeURIComponent(doc)}/segments/sync`,
        { method: "POST", body: JSON.stringify({ from, to, items, alive }), signal }
      );
      return payload.results;
    },
    detect(text: string): Promise<DetectResult> {
      return request<DetectResult>(`${basePath}/detect`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },
    health(): Promise<HealthInfo> {
      return request<HealthInfo>(`${basePath}/health`, { method: "GET" }, 8000);
    },
  };
}
