const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const USER_AGENT = "VancouverIndieCinema/0.1 (+schedule aggregator; read-only)";

export interface HttpOptions {
  timeoutMs?: number;
  attempts?: number;
}

/**
 * Statuses a site's firewall answers with when it turns away this client rather
 * than the request: Cloudflare and shared hosts refuse some GitHub runner
 * addresses with a 403 while answering the same URL from elsewhere.
 */
const BLOCKED_STATUSES = new Set([401, 403, 429]);

export class HttpError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`GET ${url} failed with ${status}`);
    this.name = "HttpError";
  }
}

/** The request never got an answer: the connection failed, was reset or timed out on every attempt. */
export class NetworkError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`GET ${url} failed: ${describeNetworkFailure(cause)}`, { cause });
    this.name = "NetworkError";
  }
}

/** Node reports every network failure as "fetch failed"; the reason (ECONNRESET, a timeout) is on its cause. */
function describeNetworkFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const detail = [cause?.code, cause?.message].filter((part) => typeof part === "string" && part.length > 0).join(": ");
  return detail ? `${error.message} (${detail})` : error.message;
}

/**
 * True when the source blocked the request (see BLOCKED_STATUSES) or could not be
 * reached at all, not when it answered with a failure or moved. Both come and go
 * with the runner's address and the host's mood.
 */
export function isBlocked(error: unknown): boolean {
  return (error instanceof HttpError && BLOCKED_STATUSES.has(error.status)) || error instanceof NetworkError;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function get(url: URL, options: HttpOptions = {}): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(250 * 2 ** (attempt - 2));

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "text/html,application/json;q=0.9,*/*;q=0.1",
          "user-agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      // Network failures and timeouts are worth another attempt.
      lastError = error;
      continue;
    }

    if (response.ok) return response;

    const error = new HttpError(url.toString(), response.status);
    if (!RETRYABLE_STATUSES.has(response.status)) throw error;
    lastError = error;
    await response.body?.cancel().catch(() => undefined);
  }

  if (lastError instanceof HttpError) throw lastError;
  throw new NetworkError(url.toString(), lastError);
}

export async function fetchText(url: URL, options?: HttpOptions): Promise<string> {
  return (await get(url, options)).text();
}

export async function fetchJson(url: URL, options?: HttpOptions): Promise<unknown> {
  return (await get(url, options)).json();
}
