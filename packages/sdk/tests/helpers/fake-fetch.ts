import type { FlagConfig } from '@feature-flags/core';

/**
 * A counting fetch stand-in. Injected via `config.fetch`, so the tests never
 * touch global state and "how many HTTP calls happened" is a plain number.
 */
export interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** How many requests have been issued. */
  calls: number;
  /** Every request, for asserting URLs and headers. */
  requests: { url: string; headers: Record<string, string> }[];
  /** Swap the behaviour mid-test to simulate a change or an outage. */
  setResponder(responder: Responder): void;
}

export type Responder = () => Promise<Response> | Response;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const respondWith = {
  flags: (flags: FlagConfig[]): Responder => () => jsonResponse({ flags }),
  status: (status: number): Responder => () => jsonResponse({ error: 'nope' }, status),
  networkError: (): Responder => () => Promise.reject(new Error('ECONNREFUSED')),
  invalidJson: (): Responder => () =>
    new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  body: (body: unknown): Responder => () => jsonResponse(body),
  /** Never settles, so the request has to be killed by its own timeout. */
  hang: (): Responder => () => new Promise<Response>(() => {}),
};

export function createFakeFetch(initial: Responder): FakeFetch {
  let responder = initial;

  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fake.calls += 1;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    fake.requests.push({ url: String(input), headers });

    // Honour the caller's AbortSignal so `hang()` behaves like a real timeout
    // rather than leaving the promise pending forever.
    const signal = init?.signal;
    if (signal) {
      return Promise.race([
        Promise.resolve(responder()),
        new Promise<Response>((_, reject) => {
          if (signal.aborted) reject(new Error('The operation was aborted'));
          signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), {
            once: true,
          });
        }),
      ]);
    }
    return responder();
  }) as FakeFetch;

  fake.calls = 0;
  fake.requests = [];
  fake.setResponder = (next: Responder) => {
    responder = next;
  };
  return fake;
}

/** Waits until `predicate` holds, or gives up. Avoids arbitrary sleeps. */
export async function until(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

export const FLAG = (overrides: Partial<FlagConfig> = {}): FlagConfig => ({
  key: 'demo-flag',
  enabled: true,
  rolloutPercentage: 25,
  targetingRules: [],
  ...overrides,
});
