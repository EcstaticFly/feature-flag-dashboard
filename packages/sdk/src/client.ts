import {
  canonicalContextJson,
  evaluateFlag,
  joinSignedContext,
  parseContext,
  SIGNED_CONTEXT_KEY_LABEL,
  toUserContext,
  type ClientContext,
  type FlagConfig,
  type UserContext,
} from '@feature-flags/core';

/**
 * The server flag client.
 *
 * It does NOT ask the API per check. It downloads whole flag configs on a timer
 * and evaluates every user locally with @feature-flags/core — the same module
 * the API itself runs, so the two can never disagree about a user. That is what
 * makes `isEnabled` synchronous and microsecond-fast, keeps API load
 * proportional to SDK instances rather than users, and lets the host app keep
 * answering correctly for its whole user base while the flag service is down.
 *
 * The governing promise: installing this package can never break the app that
 * installs it. No method throws or rejects — not even for a misconfiguration.
 * A bad config or a rejected key is reported loudly in the log and through
 * `status()`, and the client serves defaults. The reason it is not a thrown
 * error: the flag service's operator can rotate a key at any time, and that
 * must not crash every host app on its next restart.
 */

/** Replaced at build time by tsup; the fallback is for running from source. */
declare const __SDK_VERSION__: string;
const SDK_VERSION = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
/**
 * Once the key has been rejected, retry this often rather than on every tick.
 * Rotations get fixed by a deploy, not by retrying, but polling on means a
 * corrected key recovers without restarting the host.
 */
const UNAUTHORIZED_RETRY_MS = 5 * 60_000;
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

export type ClientState =
  /** Created; init() not called yet. */
  | 'idle'
  /** The last refresh succeeded. */
  | 'ready'
  /** The last refresh failed for a transient reason; last-known values are served. */
  | 'degraded'
  /** The flag service rejected the SDK key. */
  | 'unauthorized'
  /** The config itself is invalid; the client will never make a request. */
  | 'misconfigured'
  /** close() was called. */
  | 'closed';

export interface ClientStatus {
  state: ClientState;
  /** True once flags have been loaded at least once. */
  hasValues: boolean;
  /** Epoch milliseconds of the last successful load, or null. */
  lastUpdated: number | null;
  /** Why the last attempt failed, or why the config is invalid. */
  lastError: string | null;
}

export interface InitResult {
  /** True when flags were loaded. False never means an exception — check `status`. */
  ok: boolean;
  status: ClientStatus;
}

export interface FlagClient {
  /** Performs the first fetch and starts the refresh timer. Never rejects. */
  init(): Promise<InitResult>;
  isEnabled(flagKey: string, context?: UserContext, defaultValue?: boolean): boolean;
  /**
   * Evaluated values of the flags exposed to browser SDKs, for one context —
   * the bootstrap a server-rendered page hands to `flagpilot/react` so the
   * first paint is already correct. Never throws; `{}` before flags load.
   */
  getClientFlags(context?: ClientContext): Record<string, boolean>;
  /**
   * Signs a context so a browser can present it to the flag service without
   * being able to alter it. Resolves to null — never rejects — if the context
   * is invalid or this runtime has no Web Crypto.
   */
  signContext(context: ClientContext): Promise<string | null>;
  status(): ClientStatus;
  /** Stops the background refresh. */
  close(): void;
  /** Number of flags currently held. Useful in tests and health checks. */
  snapshotSize(): number;
}

/**
 * @deprecated Since 0.2.0 nothing in this package throws. Kept so existing
 * `instanceof FlagClientError` checks still compile; use `status()` instead.
 */
export class FlagClientError extends Error {
  constructor(message: string) {
    super(`flagpilot: ${message}`);
    this.name = 'FlagClientError';
  }
}

interface ValidConfig {
  apiUrl: string;
  apiKey: string;
  refreshIntervalMs: number;
  requestTimeoutMs: number;
  defaultValue: boolean;
  fetch: typeof globalThis.fetch;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Returns the usable config, or the reason it is unusable. Never throws. */
function validateConfig(config: FlagClientConfig): ValidConfig | { error: string } {
  if (config === null || typeof config !== 'object') return { error: 'a config object is required' };
  if (!nonEmpty(config.apiUrl)) return { error: 'apiUrl is required' };
  if (!nonEmpty(config.apiKey)) return { error: 'apiKey is required' };

  const refreshIntervalMs = config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  if (typeof refreshIntervalMs !== 'number' || !Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
    return { error: 'refreshIntervalMs must be a positive number' };
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    return { error: 'requestTimeoutMs must be a positive number' };
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { error: 'global fetch is unavailable; pass one via config.fetch' };
  }

  return {
    apiUrl: config.apiUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey.trim(),
    refreshIntervalMs,
    requestTimeoutMs,
    defaultValue: config.defaultValue === true,
    fetch: fetchImpl,
  };
}

let warnedBrowserEnvironment = false;

/**
 * Backstop for bundlers that ignore the package's `browser` export condition:
 * if this real server client is constructed where `window` and `document`
 * exist, say so — once. Behaviour is unchanged; the warning is the point.
 */
function warnIfInBrowser(): void {
  if (warnedBrowserEnvironment) return;
  const g = globalThis as Record<string, unknown>;
  if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined') {
    warnedBrowserEnvironment = true;
    console.warn(
      '[flagpilot] the server SDK is running in a browser. It needs your secret SDK key, which ' +
        'must never reach a browser — use flagpilot/browser or flagpilot/react instead, and ' +
        'rotate the SDK key if it has been shipped in a page.',
    );
  }
}

/** A client that answers with defaults forever and never makes a request. */
function createMisconfiguredClient(error: string, defaultValue: boolean): FlagClient {
  console.error(`[flagpilot] misconfigured, serving defaults: ${error}`);
  const snapshot = (): ClientStatus => ({
    state: 'misconfigured',
    hasValues: false,
    lastUpdated: null,
    lastError: error,
  });
  return {
    init: async () => ({ ok: false, status: snapshot() }),
    isEnabled: (_flagKey, _context, fallback) => (typeof fallback === 'boolean' ? fallback : defaultValue),
    getClientFlags: () => ({}),
    signContext: async () => null,
    status: snapshot,
    close: () => undefined,
    snapshotSize: () => 0,
  };
}

/**
 * The slice of Web Crypto `signContext` uses, typed here so the build needs
 * neither the DOM lib nor node:crypto's types — and so nothing in the published
 * typings implies a Node dependency. Node 20+, Bun, Deno and edge runtimes all
 * provide `globalThis.crypto.subtle`.
 */
interface WebCryptoSubtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array | ArrayBuffer,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

// ---- base64url over bytes, for signContext (Web Crypto has no encoder) -----

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createFlagClient(config: FlagClientConfig): FlagClient {
  warnIfInBrowser();

  let valid: ValidConfig | { error: string };
  try {
    valid = validateConfig(config);
  } catch {
    // A config whose properties throw on read is still just a bad config.
    valid = { error: 'the config object could not be read' };
  }
  if ('error' in valid) {
    const fallback = config !== null && typeof config === 'object' && config.defaultValue === true;
    return createMisconfiguredClient(valid.error, fallback);
  }

  const { apiUrl, apiKey, refreshIntervalMs, requestTimeoutMs, defaultValue: clientDefault } = valid;
  const doFetch = valid.fetch;

  let snapshot = new Map<string, FlagConfig>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let initialised = false;
  let closed = false;
  let state: ClientState = 'idle';
  let lastUpdated: number | null = null;
  let lastError: string | null = null;
  let lastAttemptAt = 0;
  /** Keys already warned about, so a hot loop logs once rather than a million times. */
  const warnedKeys = new Set<string>();
  /** True while a run of failures is ongoing, so an hour-long outage logs once. */
  let refreshFailureLogged = false;
  /** Derived signing key, computed on first use and reused. */
  let signingKey: Promise<unknown> | undefined;

  /**
   * Fetches the current configs.
   * @throws on any failure — the callers below turn every failure into state.
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

  /** One attempt. Never throws: every outcome becomes state. */
  async function attempt(): Promise<void> {
    lastAttemptAt = Date.now();
    try {
      const next = await fetchFlags();
      if (closed) return;
      snapshot = next;
      lastUpdated = Date.now();
      lastError = null;
      if (refreshFailureLogged || state === 'unauthorized') {
        console.warn('[flagpilot] flag refresh recovered');
      }
      refreshFailureLogged = false;
      state = 'ready';
    } catch (err) {
      if (closed) return;
      const status = (err as { status?: number }).status;
      lastError = (err as Error).message;
      if (status === 401 || status === 403) {
        if (state !== 'unauthorized') {
          // Loud, because it will not fix itself: the key needs changing.
          console.error(
            `[flagpilot] the flag service rejected the SDK key (HTTP ${status}). Serving defaults ` +
              'and last-known values; check apiKey. Retrying every 5 minutes.',
          );
        }
        state = 'unauthorized';
        return;
      }
      state = 'degraded';
      if (!refreshFailureLogged) {
        refreshFailureLogged = true;
        console.warn(
          initialised
            ? `[flagpilot] flag refresh failed, serving the last known values: ${lastError}`
            : `[flagpilot] could not load flags at init, serving defaults: ${lastError}`,
        );
      }
    }
  }

  async function tick(): Promise<void> {
    if (closed) return;
    if (state === 'unauthorized' && Date.now() - lastAttemptAt < UNAUTHORIZED_RETRY_MS) return;
    await attempt();
  }

  function startTimer(): void {
    if (timer || closed) return;
    timer = setInterval(() => void tick(), refreshIntervalMs);
    // Without unref() this timer would keep the host process alive forever —
    // a library must never stop its host from exiting.
    timer.unref?.();
  }

  function status(): ClientStatus {
    return { state, hasValues: lastUpdated !== null, lastUpdated, lastError };
  }

  function warnOnce(key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    console.warn(`[flagpilot] ${message}`);
  }

  async function deriveSigningKey(subtle: WebCryptoSubtle): Promise<unknown> {
    const encoder = new TextEncoder();
    const sdkKey = await subtle.importKey(
      'raw',
      encoder.encode(apiKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const derived = await subtle.sign('HMAC', sdkKey, encoder.encode(SIGNED_CONTEXT_KEY_LABEL));
    return subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }

  return {
    async init(): Promise<InitResult> {
      try {
        if (!closed) {
          await attempt();
          initialised = true;
          startTimer();
        }
      } catch {
        // attempt() cannot throw; this is the belt to its braces.
      }
      return { ok: state === 'ready', status: status() };
    },

    isEnabled(flagKey: string, context?: UserContext, defaultValue?: boolean): boolean {
      const fallback = typeof defaultValue === 'boolean' ? defaultValue : clientDefault;
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

    getClientFlags(context?: ClientContext): Record<string, boolean> {
      try {
        const parsed = parseContext(context);
        if (!parsed.ok) {
          warnOnce('getClientFlags', `getClientFlags: invalid context (${parsed.error}); returning {}`);
          return {};
        }
        // The same conversion the browser endpoint applies, so server-rendered
        // values and the browser's own fetch agree.
        const userContext = toUserContext(parsed.context);
        const values: Record<string, boolean> = {};
        for (const flag of snapshot.values()) {
          if (flag.clientSide === true) values[flag.key] = evaluateFlag(flag, userContext);
        }
        return values;
      } catch {
        return {};
      }
    },

    async signContext(context: ClientContext): Promise<string | null> {
      try {
        const parsed = parseContext(context);
        if (!parsed.ok) {
          warnOnce('signContext', `signContext: invalid context (${parsed.error}); returning null`);
          return null;
        }
        const subtle = (globalThis as { crypto?: { subtle?: WebCryptoSubtle } }).crypto?.subtle;
        if (!subtle) {
          warnOnce('signContext:crypto', 'signContext: Web Crypto is unavailable in this runtime');
          return null;
        }

        signingKey ??= deriveSigningKey(subtle);
        const key = await signingKey;
        const payload = bytesToBase64Url(new TextEncoder().encode(canonicalContextJson(parsed.context)));
        const signature = await subtle.sign('HMAC', key, new TextEncoder().encode(`v1.${payload}`));
        return joinSignedContext(payload, bytesToBase64Url(new Uint8Array(signature)));
      } catch (err) {
        // A failed derivation must not be cached as a permanent failure.
        signingKey = undefined;
        warnOnce('signContext:error', `signContext failed: ${(err as Error).message}`);
        return null;
      }
    },

    status,

    close(): void {
      closed = true;
      state = 'closed';
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    snapshotSize: () => snapshot.size,
  };
}
