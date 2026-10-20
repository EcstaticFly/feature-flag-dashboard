import { parseContext, type AttributeValue } from '@feature-flags/core';
import {
  createAbortController,
  documentTarget,
  globalFetch,
  isBrowser,
  isHidden,
  isOffline,
  windowTarget,
} from './environment.js';
import { loadPersisted, savePersisted } from './persistence.js';
import {
  EMPTY_SNAPSHOT,
  hasFlag,
  sameSnapshot,
  snapshotFromResponse,
  toSnapshot,
  type FlagSnapshot,
} from './snapshot.js';

/**
 * The browser flag client.
 *
 * Unlike the server SDK it never sees rules. It sends one request — "who is
 * this user" — and the flag service answers with evaluated booleans for the
 * flags an admin exposed to browsers. `isEnabled` then reads that answer from
 * memory: synchronous, no network, cannot block a render.
 *
 * The promise this file is built around: a page that installs it can never be
 * broken by it. No public method throws or rejects. A misconfiguration is
 * logged once and the client serves defaults. Network trouble, a flag service
 * that is down, a blocked origin, a full or forbidden localStorage, a hostile
 * response — each degrades to "last known values, then defaults", never to an
 * exception in the host page.
 */

/** Path of the browser endpoint, appended to `apiUrl`. */
export const CLIENT_FLAGS_PATH = '/api/client/flags';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const MIN_REFRESH_INTERVAL_MS = 15_000;
const MAX_REFRESH_INTERVAL_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
/** A rejected key or identity will not fix itself by retrying fast. */
const CONFIG_ERROR_RETRY_MS = 5 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 3_000;
const OFFLINE_RECHECK_MS = 30_000;
/** Responses larger than this are refused before parsing. */
const MAX_RESPONSE_CHARS = 256 * 1024;
const MAX_CLIENT_KEY_LENGTH = 256;
/** Printable ASCII only: anything else is not a valid header value. */
const CLIENT_KEY_PATTERN = /^[\x21-\x7e]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface BrowserContext {
  userId?: string;
  attributes?: Record<string, AttributeValue>;
}

/** Who the flags are for. A signed context (from your server's `signContext`) wins over a plain one. */
export interface BrowserIdentity {
  context?: BrowserContext;
  signedContext?: string;
}

export interface BrowserClientConfig extends BrowserIdentity {
  /**
   * The flag service. An https URL, an http URL on localhost, or a path on this
   * site ("/flagpilot") when your own server proxies to the flag service.
   */
  apiUrl: string;
  /** The public browser key (the flag service's CLIENT_API_KEY). Never the server SDK key. */
  clientKey: string;
  /** Values to start with, e.g. from the server SDK's `getClientFlags()` during SSR. */
  initialFlags?: Record<string, boolean>;
  /** Returned for flags that have no value. Default false. */
  defaultValue?: boolean;
  /** Refresh period. Default 60s, clamped to 15s-1h. 0 = fetch until first success, then never poll. */
  refreshIntervalMs?: number;
  /** Per-request timeout. Default 5s, clamped to 1-30s. */
  requestTimeoutMs?: number;
  /** Cache last-known values in localStorage for instant reloads. Default false. */
  persist?: boolean;
  /** Start fetching immediately. Default true; the React provider passes false and controls it. */
  autoStart?: boolean;
  /** 'warn' (default) logs warnings and errors; 'error' only errors; 'silent' nothing. */
  logLevel?: 'warn' | 'error' | 'silent';
  /** A custom fetch, for tests or special transports. */
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<unknown>;
}

export type BrowserClientState = 'idle' | 'loading' | 'ready' | 'error' | 'misconfigured' | 'closed';

export interface BrowserClientStatus {
  readonly state: BrowserClientState;
  /** Whether any values are being served (initial, cached or fetched). */
  readonly hasValues: boolean;
  /** Epoch ms of the last successful fetch, or null. */
  readonly lastUpdated: number | null;
  /** What last went wrong, or null. */
  readonly lastError: string | null;
}

export interface BrowserFlagClient {
  /** The flag's value, or the default. Synchronous; never throws. */
  isEnabled(flagKey: string, defaultValue?: boolean): boolean;
  /** Every known value, as a frozen object. The same object until something changes. */
  getAll(): Readonly<Record<string, boolean>>;
  /** Called after any change to values or status. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Switch user (sign-in, sign-out). Values for the previous user are dropped at once. Never rejects. */
  identify(identity: BrowserIdentity): Promise<void>;
  /** Fetch now. Never rejects. */
  refresh(): Promise<void>;
  /** Resolves once the first fetch has settled, or after `timeoutMs`. Never rejects. */
  ready(timeoutMs?: number): Promise<void>;
  getStatus(): BrowserClientStatus;
  /** Begin fetching and polling. No-op outside a browser. */
  start(): void;
  /** Pause polling. Reversible with start(). */
  stop(): void;
  /** Stop for good. Values remain readable. */
  close(): void;
}

// ---- helpers -----------------------------------------------------------------

type Logger = (level: 'warn' | 'error', message: string) => void;

function makeLogger(level: BrowserClientConfig['logLevel']): Logger {
  const threshold = level === 'silent' ? 3 : level === 'error' ? 2 : 1;
  return (severity, message) => {
    if ((severity === 'warn' ? 1 : 2) < threshold) return;
    try {
      // Never the context, the key or a token — only what is needed to fix it.
      (severity === 'warn' ? console.warn : console.error)(`[flagpilot] ${message}`);
    } catch {
      // A broken console is not our problem to make worse.
    }
  };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** The endpoint URL, or why `apiUrl` is unusable. */
function resolveEndpoint(apiUrl: unknown): { url: string } | { error: string } {
  if (typeof apiUrl !== 'string' || apiUrl.trim().length === 0) return { error: 'apiUrl is required' };
  const raw = apiUrl.trim();

  // A same-origin path: your own server proxies to the flag service. No CORS,
  // a first-party URL, and nothing for an ad blocker to match.
  if (raw.startsWith('/')) {
    // "//host" is a protocol-relative URL to another site, not a path.
    if (raw.startsWith('//')) return { error: 'apiUrl must not be protocol-relative ("//host")' };
    return { url: raw.replace(/\/+$/, '') + CLIENT_FLAGS_PATH };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `apiUrl '${raw}' is not a valid URL` };
  }
  if (url.username !== '' || url.password !== '') return { error: 'apiUrl must not contain credentials' };
  if (url.search !== '' || url.hash !== '') return { error: 'apiUrl must not contain a query or fragment' };
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    // Contexts carry user ids. Over plain HTTP anyone on the path can read them.
    return { error: 'apiUrl must use https (http is allowed for localhost only)' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'apiUrl must be an http(s) URL' };
  return { url: url.origin + url.pathname.replace(/\/+$/, '') + CLIENT_FLAGS_PATH };
}

interface ResolvedIdentity {
  /** The request body. */
  body: string;
  /** Stable identity key: storage tagging and change detection. */
  key: string;
}

/** The request body for an identity, or why it cannot be sent. Never throws. */
function resolveIdentity(identity: BrowserIdentity | undefined): ResolvedIdentity | { error: string } {
  if (identity?.signedContext !== undefined) {
    if (typeof identity.signedContext !== 'string' || identity.signedContext.length === 0) {
      return { error: 'signedContext must be a non-empty string' };
    }
    return { body: JSON.stringify({ signedContext: identity.signedContext }), key: `s:${identity.signedContext}` };
  }
  const parsed = parseContext(identity?.context);
  if (!parsed.ok) return { error: `invalid context: ${parsed.error}` };
  const context = parsed.context;
  if (context.userId === undefined && context.attributes === undefined) return { body: '{}', key: 'anon' };
  const body = JSON.stringify({ context });
  return { body, key: `c:${body}` };
}

function errorCodeOf(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A specific, actionable message for each way the service can refuse a request. */
function configErrorMessage(status: number, code: string | undefined, url: string): string {
  switch (code) {
    case 'invalid_client_key':
      return 'the flag service rejected the client key. Use its public CLIENT_API_KEY — never the server SDK key.';
    case 'signed_context_required':
      return (
        'this flag service only accepts a user identity signed by your server. Pass signedContext ' +
        '(from the server SDK\'s signContext()) instead of a userId, or omit the context to stay anonymous.'
      );
    case 'invalid_signed_context':
      return 'signedContext was rejected: it must come from signContext() on a server using this flag service\'s SDK key.';
    case 'invalid_context':
      return 'the flag service rejected the context; check userId and attributes against the documented limits.';
    case 'origin_not_allowed':
      return 'this site\'s origin is not in the flag service\'s CLIENT_ALLOWED_ORIGINS.';
    default:
      if (status === 404) {
        return `no browser endpoint at ${url}. Check apiUrl, and that CLIENT_API_KEY is set on the flag service.`;
      }
      return `the flag service refused the request (HTTP ${status}${code ? `, ${code}` : ''}).`;
  }
}

type Outcome =
  | { kind: 'success'; flags: FlagSnapshot }
  | { kind: 'transient'; message: string }
  | { kind: 'config'; status: number; code: string | undefined };

/** Config-type failures: retrying soon will not change the answer. */
const CONFIG_STATUSES = new Set([400, 401, 403, 404, 413, 415]);

function freezeStatus(status: BrowserClientStatus): BrowserClientStatus {
  return Object.freeze({ ...status });
}

/** A client that answers with defaults forever and never touches the network. */
function createInertClient(
  reason: string,
  defaultValue: boolean,
  initial: FlagSnapshot,
  log: Logger,
): BrowserFlagClient {
  log('error', `browser client misconfigured, serving defaults: ${reason}`);
  const status = freezeStatus({ state: 'misconfigured', hasValues: false, lastUpdated: null, lastError: reason });
  return {
    isEnabled: (flagKey, fallback) =>
      typeof flagKey === 'string' && hasFlag(initial, flagKey)
        ? (initial[flagKey] as boolean)
        : typeof fallback === 'boolean'
          ? fallback
          : defaultValue,
    getAll: () => initial,
    subscribe: () => () => undefined,
    identify: async () => undefined,
    refresh: async () => undefined,
    ready: async () => undefined,
    getStatus: () => status,
    start: () => undefined,
    stop: () => undefined,
    close: () => undefined,
  };
}

// ---- the client --------------------------------------------------------------

export function createBrowserClient(config: BrowserClientConfig): BrowserFlagClient {
  // Reading the config is guarded as a whole: a config with throwing getters
  // is just another bad config.
  let log: Logger = makeLogger('warn');
  let defaultValue = false;
  let initial: FlagSnapshot = EMPTY_SNAPSHOT;
  try {
    if (config === null || typeof config !== 'object') {
      return createInertClient('a config object is required', false, EMPTY_SNAPSHOT, log);
    }
    log = makeLogger(config.logLevel);
    defaultValue = config.defaultValue === true;
    if (config.initialFlags !== undefined) {
      const fromProps = toSnapshot(config.initialFlags);
      if (fromProps) initial = fromProps;
      else log('warn', 'initialFlags ignored: expected an object of booleans');
    }
  } catch {
    return createInertClient('the config object could not be read', false, EMPTY_SNAPSHOT, log);
  }

  let endpoint: string;
  let clientKey: string;
  let identity: ResolvedIdentity | undefined;
  let identityError: string | undefined;
  let refreshIntervalMs: number;
  let timeoutMs: number;
  let persist: boolean;
  let autoStart: boolean;
  let customFetch: BrowserClientConfig['fetch'];
  try {
    const resolved = resolveEndpoint(config.apiUrl);
    if ('error' in resolved) return createInertClient(resolved.error, defaultValue, initial, log);
    endpoint = resolved.url;

    const key = typeof config.clientKey === 'string' ? config.clientKey.trim() : '';
    if (key.length === 0) return createInertClient('clientKey is required', defaultValue, initial, log);
    if (key.length > MAX_CLIENT_KEY_LENGTH || !CLIENT_KEY_PATTERN.test(key)) {
      return createInertClient('clientKey is not a valid key', defaultValue, initial, log);
    }
    clientKey = key;

    const resolvedIdentity = resolveIdentity({ context: config.context, signedContext: config.signedContext });
    if ('error' in resolvedIdentity) identityError = resolvedIdentity.error;
    else identity = resolvedIdentity;

    refreshIntervalMs =
      config.refreshIntervalMs === 0
        ? 0
        : clamp(config.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS, MIN_REFRESH_INTERVAL_MS, MAX_REFRESH_INTERVAL_MS);
    timeoutMs = clamp(config.requestTimeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    persist = config.persist === true;
    autoStart = config.autoStart !== false;
    customFetch = typeof config.fetch === 'function' ? config.fetch : undefined;
  } catch {
    return createInertClient('the config object could not be read', defaultValue, initial, log);
  }

  // ---- state ----

  let flags: FlagSnapshot = initial;
  if (flags === EMPTY_SNAPSHOT && persist && identity) {
    flags = loadPersisted(clientKey, identity.key) ?? EMPTY_SNAPSHOT;
  }
  let status = freezeStatus({
    state: identityError ? 'error' : 'idle',
    hasValues: Object.keys(flags).length > 0,
    lastUpdated: null,
    lastError: identityError ?? null,
  });
  if (identityError) log('error', `${identityError}. Serving defaults until identify() is given a valid one.`);

  const listeners = new Set<() => void>();
  let running = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The one request in flight. A response is applied only if it is still current. */
  let current: { abort(): void; promise: Promise<void> } | undefined;
  let consecutiveFailures = 0;
  let failureLogged = false;
  const loggedConfigErrors = new Set<string>();
  let lastSuccessAt: number | null = null;
  let hasLoadedOnce = false;
  let firstSettled = false;
  const readyWaiters = new Set<() => void>();
  const warnedUnknown = new Set<string>();
  let pendingWhileHidden = false;

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        // A host listener that throws must not stop the others, or the client.
        log('error', `a subscriber threw: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  }

  function setStatus(patch: Partial<BrowserClientStatus>): void {
    const next = { ...status, ...patch };
    if (
      next.state === status.state &&
      next.hasValues === status.hasValues &&
      next.lastUpdated === status.lastUpdated &&
      next.lastError === status.lastError
    ) {
      return;
    }
    status = freezeStatus(next);
    notify();
  }

  function setFlags(next: FlagSnapshot): boolean {
    if (sameSnapshot(flags, next)) return false;
    flags = next;
    return true;
  }

  function settleFirst(): void {
    if (firstSettled) return;
    firstSettled = true;
    for (const resolve of [...readyWaiters]) resolve();
    readyWaiters.clear();
  }

  function isStale(): boolean {
    if (lastSuccessAt === null) return true;
    if (refreshIntervalMs === 0) return false;
    const elapsed = Date.now() - lastSuccessAt;
    // A clock moved backwards is treated as stale, not as "fresh for an hour".
    return elapsed < 0 || elapsed >= refreshIntervalMs;
  }

  function schedule(delayMs: number): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!running || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, Math.max(0, delayMs));
  }

  function backoffDelay(): number {
    const cap = refreshIntervalMs > 0 ? refreshIntervalMs : DEFAULT_REFRESH_INTERVAL_MS;
    const base = Math.min(cap, 1000 * 2 ** Math.min(consecutiveFailures - 1, 10));
    return base * (0.8 + Math.random() * 0.4);
  }

  async function tick(): Promise<void> {
    if (!running || closed) return;
    // No polling for a hidden tab — but the FIRST load still happens, so a
    // tab opened in the background has real values when it is first shown.
    if (hasLoadedOnce && isHidden()) {
      pendingWhileHidden = true; // resumed by the visibilitychange listener
      return;
    }
    if (isOffline()) {
      // The `online` event resumes immediately; this recheck covers browsers
      // and webviews that misreport being offline and never fire it.
      schedule(OFFLINE_RECHECK_MS);
      return;
    }
    await fetchNow();
  }

  /** One request. Never throws. */
  async function request(signal: unknown): Promise<Outcome> {
    const fetchImpl = customFetch ?? globalFetch();
    if (!fetchImpl) return { kind: 'transient', message: 'fetch is not available in this browser' };
    if (!identity) return { kind: 'transient', message: identityError ?? 'no identity' };

    const body = identity.body;
    const work = (async (): Promise<Outcome> => {
      const response = (await fetchImpl.call(globalThis, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-flagpilot-client-key': clientKey },
        body,
        // No cookies to a third party, and nothing for one to set.
        credentials: 'omit',
        cache: 'no-store',
        // The flag service never redirects. Following one would send the key
        // and the context to wherever the redirect pointed.
        redirect: 'error',
        // The flag service has no need to know which page the user is on.
        referrerPolicy: 'no-referrer',
        signal,
      })) as { status: number; headers?: { get?(name: string): string | null }; text(): Promise<string> };

      const status = typeof response?.status === 'number' ? response.status : 0;
      if (status === 200) {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) {
          return { kind: 'transient', message: 'response too large' };
        }
        const text = await response.text();
        if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) {
          return { kind: 'transient', message: 'response too large' };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { kind: 'transient', message: 'response was not valid JSON' };
        }
        const next = snapshotFromResponse(parsed);
        return next ? { kind: 'success', flags: next } : { kind: 'transient', message: 'unexpected response shape' };
      }

      if (CONFIG_STATUSES.has(status)) {
        let code: string | undefined;
        try {
          code = errorCodeOf(JSON.parse(await response.text()));
        } catch {
          // Unreadable error body: the status alone has to do.
        }
        return { kind: 'config', status, code };
      }
      return { kind: 'transient', message: `flag service responded ${status || 'without a status'}` };
    })();

    // One deadline for the whole exchange, headers and body. Without an
    // AbortController the late result is simply ignored.
    return new Promise<Outcome>((resolve) => {
      const deadline = setTimeout(
        () => resolve({ kind: 'transient', message: `timed out after ${timeoutMs}ms` }),
        timeoutMs,
      );
      work.then(
        (outcome) => {
          clearTimeout(deadline);
          resolve(outcome);
        },
        (err: unknown) => {
          clearTimeout(deadline);
          resolve({ kind: 'transient', message: (err as Error)?.message || 'network error' });
        },
      );
    });
  }

  function apply(outcome: Outcome, identityKey: string): void {
    if (outcome.kind === 'success') {
      consecutiveFailures = 0;
      if (failureLogged) log('warn', 'flag service reachable again');
      failureLogged = false;
      loggedConfigErrors.clear();
      lastSuccessAt = Date.now();
      hasLoadedOnce = true;
      const changed = setFlags(outcome.flags);
      if (persist) savePersisted(clientKey, identityKey, flags);
      if (changed) notify();
      setStatus({ state: 'ready', hasValues: true, lastUpdated: lastSuccessAt, lastError: null });
      if (refreshIntervalMs > 0) schedule(refreshIntervalMs);
      return;
    }

    if (outcome.kind === 'config') {
      const message = configErrorMessage(outcome.status, outcome.code, endpoint);
      const signature = `${outcome.status}:${outcome.code ?? ''}`;
      if (!loggedConfigErrors.has(signature)) {
        loggedConfigErrors.add(signature);
        log('error', `${message} Serving ${status.hasValues ? 'last-known values' : 'defaults'}.`);
      }
      setStatus({ state: 'error', lastError: message });
      schedule(CONFIG_ERROR_RETRY_MS);
      return;
    }

    consecutiveFailures += 1;
    if (!failureLogged) {
      failureLogged = true;
      log(
        'warn',
        `could not load flags (${outcome.message}); serving ${
          status.hasValues ? 'last-known values' : 'defaults'
        }. If this persists, check apiUrl, that this site's origin is in the flag service's ` +
          'CLIENT_ALLOWED_ORIGINS, and that any Content-Security-Policy connect-src allows the flag service.',
      );
    }
    setStatus({ state: 'error', lastError: outcome.message });
    schedule(backoffDelay());
  }

  /** Starts a request unless one is already running. Never rejects. */
  function fetchNow(): Promise<void> {
    if (closed || !identity) return Promise.resolve();
    if (current) return current.promise;

    const controller = createAbortController();
    const requestIdentity = identity;
    if (!hasLoadedOnce && status.state !== 'loading') setStatus({ state: 'loading' });

    const entry: { abort(): void; promise: Promise<void> } = {
      abort: () => controller?.abort(),
      promise: Promise.resolve(),
    };
    entry.promise = request(controller?.signal)
      .then((outcome) => {
        // Superseded — by identify(), stop() or close() — while in flight:
        // this answer is for a request nobody is waiting on any more.
        if (current !== entry || closed) return;
        current = undefined;
        apply(outcome, requestIdentity.key);
        settleFirst();
      })
      .catch(() => {
        // apply() cannot throw; this keeps a bug from ever surfacing as an
        // unhandled rejection in the host page.
        if (current === entry) current = undefined;
      });
    current = entry;
    return entry.promise;
  }

  function abortCurrent(): void {
    const entry = current;
    current = undefined;
    try {
      entry?.abort();
    } catch {
      // Aborting is best-effort.
    }
  }

  // ---- page lifecycle ----

  const onVisibilityChange = (): void => {
    if (!running || closed || isHidden()) return;
    if (pendingWhileHidden || isStale()) {
      pendingWhileHidden = false;
      schedule(0);
    }
  };
  const onOnline = (): void => {
    if (running && !closed && isStale()) schedule(0);
  };
  const onPageShow = (event: unknown): void => {
    // Restored from the back/forward cache: timers resumed, but the values may be old.
    if (running && !closed && (event as { persisted?: boolean } | null)?.persisted === true && isStale()) {
      schedule(0);
    }
  };

  function attachListeners(): void {
    try {
      documentTarget()?.addEventListener('visibilitychange', onVisibilityChange);
      const w = windowTarget();
      w?.addEventListener('online', onOnline);
      w?.addEventListener('pageshow', onPageShow);
      // Deliberately no unload/beforeunload listener: either would make the
      // page ineligible for the back/forward cache.
    } catch {
      // Without lifecycle events the client still polls on its timer.
    }
  }

  function detachListeners(): void {
    try {
      documentTarget()?.removeEventListener('visibilitychange', onVisibilityChange);
      const w = windowTarget();
      w?.removeEventListener('online', onOnline);
      w?.removeEventListener('pageshow', onPageShow);
    } catch {
      // Best-effort.
    }
  }

  // ---- public API ----

  const client: BrowserFlagClient = {
    isEnabled(flagKey: string, fallback?: boolean): boolean {
      const resolvedDefault = typeof fallback === 'boolean' ? fallback : defaultValue;
      try {
        if (typeof flagKey !== 'string') return resolvedDefault;
        if (hasFlag(flags, flagKey)) return flags[flagKey] as boolean;
        if (hasLoadedOnce && !warnedUnknown.has(flagKey)) {
          warnedUnknown.add(flagKey);
          log('warn', `unknown flag '${flagKey}': it doesn't exist, or isn't enabled for browser SDKs in the dashboard`);
        }
        return resolvedDefault;
      } catch {
        return resolvedDefault;
      }
    },

    getAll: () => flags,

    subscribe(listener: () => void): () => void {
      if (typeof listener !== 'function') return () => undefined;
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },

    async identify(next: BrowserIdentity): Promise<void> {
      try {
        if (closed) return;
        const resolved = resolveIdentity(next);
        if ('error' in resolved) {
          log('error', `${resolved.error}. Serving defaults until identify() is given a valid one.`);
          abortCurrent();
          identity = undefined;
          identityError = resolved.error;
          setFlags(EMPTY_SNAPSHOT);
          notify();
          setStatus({ state: 'error', hasValues: false, lastError: resolved.error });
          return;
        }
        if (identity && resolved.key === identity.key) return;

        // A different user. Drop the previous user's values at once — never
        // show one person's flags to the next, not even until the refetch.
        abortCurrent();
        identity = resolved;
        identityError = undefined;
        consecutiveFailures = 0;
        failureLogged = false;
        loggedConfigErrors.clear();
        lastSuccessAt = null;
        hasLoadedOnce = false;
        const cached = persist ? loadPersisted(clientKey, resolved.key) : null;
        if (setFlags(cached ?? EMPTY_SNAPSHOT)) notify();
        setStatus({ state: running ? 'loading' : 'idle', hasValues: cached !== null, lastUpdated: null, lastError: null });
        if (running) {
          // Fetch directly. A pending tick is cancelled first rather than
          // scheduled alongside: if this response landed before a 0ms timer
          // fired, the timer would start a second, redundant request.
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          await fetchNow();
        }
      } catch {
        // identify() never rejects.
      }
    },

    refresh(): Promise<void> {
      try {
        if (closed || !isBrowser() || !identity) return Promise.resolve();
        return fetchNow();
      } catch {
        return Promise.resolve();
      }
    },

    ready(waitMs?: number): Promise<void> {
      return new Promise<void>((resolve) => {
        try {
          if (firstSettled || closed || !isBrowser() || !identity) {
            resolve();
            return;
          }
          readyWaiters.add(resolve);
          setTimeout(() => {
            readyWaiters.delete(resolve);
            resolve();
          }, clamp(waitMs, DEFAULT_READY_TIMEOUT_MS, 0, 60_000));
        } catch {
          resolve();
        }
      });
    },

    getStatus: () => status,

    start(): void {
      try {
        if (closed || running || !isBrowser()) return;
        running = true;
        attachListeners();
        if (!identity) return; // waits for identify()
        schedule(isStale() ? 0 : Math.max(0, refreshIntervalMs - (Date.now() - (lastSuccessAt ?? 0))));
      } catch {
        // start() never throws.
      }
    },

    stop(): void {
      try {
        running = false;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        abortCurrent();
        detachListeners();
        if (status.state === 'loading') setStatus({ state: hasLoadedOnce ? 'ready' : 'idle' });
      } catch {
        // stop() never throws.
      }
    },

    close(): void {
      try {
        if (closed) return;
        client.stop();
        closed = true;
        settleFirst();
        setStatus({ state: 'closed' });
        listeners.clear();
      } catch {
        // close() never throws.
      }
    },
  };

  if (autoStart) client.start();
  return client;
}
