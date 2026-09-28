import { evaluateFlag, type FlagConfig, type UserContext } from '@feature-flags/core';

/**
 * The flag client.
 *
 * It does NOT ask the API per check. It downloads whole flag configs on a timer
 * and evaluates every user locally with @feature-flags/core — the same module
 * the API itself runs, so the two can never disagree about a user. That is what
 * makes `isEnabled` synchronous and microsecond-fast, keeps API load
 * proportional to SDK instances rather than users, and lets the host app keep
 * answering correctly for its whole user base while the flag service is down.
 *
 * The governing promise: installing this package can never break the app that
 * installs it. `isEnabled` never throws and never touches the network.
 */

/** Replaced at build time by tsup; the fallback is for running from source. */
declare const __SDK_VERSION__: string;
const SDK_VERSION = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const FLAGS_PATH = '/api/sdk/flags';

export interface FlagClientConfig {
  /** Base URL of the flag API, e.g. https://flags.example.com */
  apiUrl: string;
  /** The read-only SDK key. Server-side only — never ship this to a browser. */
  apiKey: string;
  /** How often to refresh configs. Default 30_000; demos often use 5_000. */
  refreshIntervalMs?: number;
  /** Returned when a flag cannot be resolved. Default false. */
  defaultValue?: boolean;
  /** Per-request timeout for the background refresh. Default 2_000. */
  requestTimeoutMs?: number;
  /** Injectable fetch. For tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface FlagClient {
  /** Validates config and performs the first fetch. The only async call. */
  init(): Promise<void>;
  isEnabled(flagKey: string, context?: UserContext, defaultValue?: boolean): boolean;
  /** Stops the background refresh. */
  close(): void;
  /** Number of flags currently held. Useful in tests and health checks. */
  snapshotSize(): number;
}

/** Thrown from init() for developer errors — never for runtime conditions. */
export class FlagClientError extends Error {
  constructor(message: string) {
    super(`@feature-flags/sdk: ${message}`);
    this.name = 'FlagClientError';
  }
}

function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FlagClientError(`${name} is required`);
  }
  return value.trim();
}

export function createFlagClient(config: FlagClientConfig): FlagClient {
  const apiUrl = requireNonEmpty(config.apiUrl, 'apiUrl').replace(/\/+$/, '');
  const apiKey = requireNonEmpty(config.apiKey, 'apiKey');

  const refreshIntervalMs = config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
    throw new FlagClientError('refreshIntervalMs must be a positive number');
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new FlagClientError('requestTimeoutMs must be a positive number');
  }

  const clientDefault = config.defaultValue ?? false;
  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new FlagClientError('global fetch is unavailable; pass one via config.fetch');
  }

  let snapshot = new Map<string, FlagConfig>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let initialised = false;
  /** Keys already warned about, so a hot loop logs once rather than a million times. */
  const warnedKeys = new Set<string>();
  /** True while a run of failures is ongoing, so an hour-long outage logs once. */
  let refreshFailureLogged = false;

  /**
   * Fetches the current configs.
   * @throws on any failure — callers decide whether that is fatal.
   */
  async function fetchFlags(): Promise<Map<string, FlagConfig>> {
    const response = await doFetch(`${apiUrl}${FLAGS_PATH}`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'x-sdk-version': SDK_VERSION,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) {
      const error = new Error(`flag service responded ${response.status}`);
      // Marked so init() can tell a developer error from an outage.
      (error as { status?: number }).status = response.status;
      throw error;
    }

    const body: unknown = await response.json();
    const flags = (body as { flags?: unknown } | null)?.flags;
    if (!Array.isArray(flags)) {
      throw new Error('flag service returned an unexpected body');
    }

    const next = new Map<string, FlagConfig>();
    for (const flag of flags as FlagConfig[]) {
      if (flag && typeof flag.key === 'string') next.set(flag.key, flag);
    }
    return next;
  }

  /** A refresh that never throws: on failure the previous snapshot is kept. */
  async function refresh(): Promise<void> {
    try {
      snapshot = await fetchFlags();
      if (refreshFailureLogged) {
        console.warn('[feature-flags] flag refresh recovered');
        refreshFailureLogged = false;
      }
    } catch (err) {
      if (!refreshFailureLogged) {
        refreshFailureLogged = true;
        console.warn(
          `[feature-flags] flag refresh failed, serving the last known values: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => void refresh(), refreshIntervalMs);
    // Without unref() this timer would keep the host process alive forever —
    // a library must never stop its host from exiting.
    timer.unref?.();
  }

  return {
    async init(): Promise<void> {
      try {
        snapshot = await fetchFlags();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) {
          // A rejected key is a misconfigured deployment. Fail loudly at
          // startup, where a developer will see it, rather than silently
          // serving defaults forever.
          throw new FlagClientError(
            `the flag service rejected the API key (HTTP ${status}). Check apiKey.`,
          );
        }
        // Anything else — unreachable, timeout, 5xx, malformed body — must not
        // stop the host app from booting. Defaults are served until a refresh
        // succeeds.
        refreshFailureLogged = true;
        console.warn(
          `[feature-flags] could not load flags at init, serving defaults: ${
            (err as Error).message
          }`,
        );
      }
      initialised = true;
      startTimer();
    },

    isEnabled(flagKey: string, context?: UserContext, defaultValue?: boolean): boolean {
      const fallback = defaultValue ?? clientDefault;
      try {
        if (!initialised) {
          warnOnce(flagKey, `isEnabled('${flagKey}') called before init(); returning the default`);
          return fallback;
        }

        const flag = snapshot.get(flagKey);
        if (!flag) {
          warnOnce(flagKey, `unknown flag '${flagKey}'; returning the default`);
          return fallback;
        }

        return evaluateFlag(flag, context);
      } catch (err) {
        // Belt and braces: a bug in here must never reach the host app's
        // request path.
        warnOnce(flagKey, `evaluation of '${flagKey}' failed: ${(err as Error).message}`);
        return fallback;
      }
    },

    close(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    snapshotSize: () => snapshot.size,
  };

  function warnOnce(key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    console.warn(`[feature-flags] ${message}`);
  }
}
