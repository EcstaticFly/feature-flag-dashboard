import { vi } from 'vitest';

/**
 * A scriptable fetch for the browser client. Each request waits for the test
 * to answer it, so the order responses arrive in — the thing that matters for
 * identity races — is under the test's control.
 */

export interface RecordedRequest {
  url: string;
  init: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string>;
  respond(response: Response): void;
  fail(error?: Error): void;
  /** Whether the request's AbortSignal fired. */
  aborted(): boolean;
}

export interface ScriptedFetch {
  (input: string, init?: Record<string, unknown>): Promise<Response>;
  requests: RecordedRequest[];
  /** Answer every request immediately with this (instead of waiting for the test). */
  autoRespond(make: (() => Response) | undefined): void;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const flagsResponse = (flags: Record<string, unknown>) => json({ flags });

export function createScriptedFetch(): ScriptedFetch {
  let auto: (() => Response) | undefined;
  const fetchFn = ((input: string, init: Record<string, unknown> = {}) =>
    new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) {
        headers[k.toLowerCase()] = v;
      }
      const signal = init.signal as AbortSignal | undefined;
      let settled = false;
      const request: RecordedRequest = {
        url: input,
        init,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        headers,
        respond(response) {
          if (!settled) {
            settled = true;
            resolve(response);
          }
        },
        fail(error = new TypeError('Failed to fetch')) {
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
        aborted: () => signal?.aborted === true,
      };
      signal?.addEventListener('abort', () => request.fail(new DOMException('aborted', 'AbortError')));
      fetchFn.requests.push(request);
      if (auto) request.respond(auto());
    })) as ScriptedFetch;
  fetchFn.requests = [];
  fetchFn.autoRespond = (make) => {
    auto = make;
  };
  return fetchFn;
}

/** Lets pending promise callbacks run (fake timers do not advance microtasks on their own). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

export function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

export function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  if (online) window.dispatchEvent(new Event('online'));
}

export function silenceConsole() {
  return {
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

export const BASE = {
  apiUrl: 'https://flags.example.com',
  clientKey: 'public-client-key-123',
};
