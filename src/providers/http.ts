import { ProviderError } from "./types.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST JSON with retries on 408/409/429/5xx and network errors, honoring Retry-After. */
export async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const f = opts.fetchImpl ?? fetch;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text();
      const retryable = [408, 409, 429, 500, 502, 503, 504, 529].includes(res.status);
      lastErr = new ProviderError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
      if (!retryable || attempt === retries) throw lastErr;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : base * 2 ** attempt + Math.random() * 250);
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw e;
      lastErr = e;
      if (attempt === retries) break;
      await sleep(base * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError(String(lastErr));
}
