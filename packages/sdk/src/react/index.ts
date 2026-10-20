import { canonicalContextJson, parseContext } from '@feature-flags/core';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  createBrowserClient,
  type BrowserClientConfig,
  type BrowserClientStatus,
  type BrowserContext,
  type BrowserFlagClient,
} from '../browser/client.js';
import { EMPTY_SNAPSHOT, hasFlag, toSnapshot, type FlagSnapshot } from '../browser/snapshot.js';

/**
 * flagpilot/react — React bindings for the browser client.
 *
 * ```tsx
 * <FlagProvider apiUrl="https://flags.example.com" clientKey="…" signedContext={token}>
 *   <App />
 * </FlagProvider>
 *
 * const on = useFlag('new-checkout-flow');
 * ```
 *
 * Works in Vite and Create React App, and in Next.js client components. This
 * module ships with "use client" as its first line, so `<FlagProvider>` can be
 * rendered straight from a Next.js server component (its props are plain data).
 *
 * Like everything in flagpilot, nothing here throws: a hook outside a provider,
 * a bad config, a flag service that is down — each yields the default and, at
 * most, one console message. Deliberately unlike React's usual convention of
 * throwing for a missing provider: a flag check must never be what takes a
 * page down.
 */

export type FlagProviderOptions = Pick<
  BrowserClientConfig,
  'refreshIntervalMs' | 'requestTimeoutMs' | 'persist' | 'defaultValue' | 'logLevel'
>;

export interface FlagProviderProps {
  /** The flag service, or a same-origin proxy path. */
  apiUrl: string;
  /** The public browser key (CLIENT_API_KEY). */
  clientKey: string;
  /** A token from your server's `signContext()` — who the user is. Wins over `context`. */
  signedContext?: string;
  /** A plain context. Only accepted if the flag service allows unsigned identities. */
  context?: BrowserContext;
  /**
   * Values from the server render (the server SDK's `getClientFlags()`), so the
   * first paint is already correct. Read at mount only.
   */
  initialFlags?: Record<string, boolean>;
  options?: FlagProviderOptions;
  children?: ReactNode;
}

interface Store {
  client: BrowserFlagClient;
  /** What the server rendered with — never cached storage — so hydration matches. */
  serverSnapshot: FlagSnapshot;
  serverStatus: BrowserClientStatus;
  defaultValue: boolean;
}

const FlagContext = createContext<Store | null>(null);

const IDLE_STATUS: BrowserClientStatus = Object.freeze({
  state: 'idle',
  hasValues: false,
  lastUpdated: null,
  lastError: null,
});

const noopSubscribe = () => () => undefined;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.warn(`[flagpilot] ${message}`);
  } catch {
    // Nothing to do about a broken console.
  }
}

/** A stable string per identity, so a new-but-equal `context` object never refetches. */
function identityKeyOf(signedContext: string | undefined, context: BrowserContext | undefined): string {
  if (signedContext !== undefined) return `s:${signedContext}`;
  const parsed = parseContext(context);
  return parsed.ok ? `c:${canonicalContextJson(parsed.context)}` : 'invalid';
}

function createStore(props: FlagProviderProps): Store {
  const options = props.options ?? {};
  const defaultValue = options.defaultValue === true;
  let client: BrowserFlagClient;
  try {
    client = createBrowserClient({
      apiUrl: props.apiUrl,
      clientKey: props.clientKey,
      signedContext: props.signedContext,
      context: props.signedContext !== undefined ? undefined : props.context,
      initialFlags: props.initialFlags,
      refreshIntervalMs: options.refreshIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      persist: options.persist,
      defaultValue: options.defaultValue,
      logLevel: options.logLevel,
      // The provider controls the lifecycle, so Strict Mode's
      // mount → unmount → mount and server rendering both behave.
      autoStart: false,
    });
  } catch {
    // createBrowserClient does not throw; this keeps a future bug from
    // ever escaping into render.
    client = createBrowserClient(null as never);
  }
  const serverSnapshot = toSnapshot(props.initialFlags) ?? EMPTY_SNAPSHOT;
  return {
    client,
    serverSnapshot,
    serverStatus: Object.freeze({ ...IDLE_STATUS, hasValues: Object.keys(serverSnapshot).length > 0 }),
    defaultValue,
  };
}

/**
 * Provides flags to every hook below it. Put it once, near the root.
 *
 * Changing `apiUrl`, `clientKey` or `options` creates a new client. Changing
 * who the user is (`signedContext` / `context`) keeps the client and calls
 * `identify()`, which drops the previous user's values immediately.
 */
export function FlagProvider(props: FlagProviderProps): ReactElement {
  const { apiUrl, clientKey, signedContext, context, options, children } = props;
  const configKey = [
    apiUrl,
    clientKey,
    options?.refreshIntervalMs,
    options?.requestTimeoutMs,
    options?.persist,
    options?.defaultValue,
    options?.logLevel,
  ].join('|');
  const identityKey = identityKeyOf(signedContext, context);

  // Constructing a client has no side effects — no request, no timer, no
  // listener — so doing it during render is safe, including in a render React
  // later discards. Everything with an effect happens in useEffect below.
  const ref = useRef<{ configKey: string; identityKey: string; store: Store } | null>(null);
  if (ref.current === null || ref.current.configKey !== configKey) {
    ref.current = { configKey, identityKey, store: createStore(props) };
  }
  const store = ref.current.store;

  useEffect(() => {
    // stop(), not close(): Strict Mode runs effects mount → unmount → mount on
    // the same client, so the cleanup must be reversible.
    store.client.start();
    return () => store.client.stop();
  }, [store]);

  useEffect(() => {
    const current = ref.current;
    if (!current || current.store !== store || current.identityKey === identityKey) return;
    current.identityKey = identityKey;
    void store.client.identify(signedContext !== undefined ? { signedContext } : { context });
    // `context` is deliberately not a dependency: identityKey captures its
    // value, so an equal-but-new object every render does not re-identify.
  }, [store, identityKey]);

  const both = signedContext !== undefined && context !== undefined;
  useEffect(() => {
    if (both) warnOnce('both-identities', 'FlagProvider got both signedContext and context; using signedContext');
  }, [both]);

  return createElement(FlagContext.Provider, { value: store }, children);
}

function useStore(hook: string): Store | null {
  const store = useContext(FlagContext);
  if (store === null) warnOnce(`outside:${hook}`, `${hook}() used outside <FlagProvider>; returning defaults`);
  return store;
}

/** The flag's value for the current user. Re-renders only when this flag changes. */
export function useFlag(flagKey: string, defaultValue?: boolean): boolean {
  const store = useStore('useFlag');
  const fallback = typeof defaultValue === 'boolean' ? defaultValue : (store?.defaultValue ?? false);
  const read = (snapshot: FlagSnapshot): boolean =>
    typeof flagKey === 'string' && hasFlag(snapshot, flagKey) ? (snapshot[flagKey] as boolean) : fallback;

  return useSyncExternalStore(
    store ? store.client.subscribe : noopSubscribe,
    // Client: through isEnabled, which also warns once about an unknown key.
    () => (store ? store.client.isEnabled(flagKey, fallback) : fallback),
    // Server, and during hydration: exactly what the server rendered with.
    () => (store ? read(store.serverSnapshot) : fallback),
  );
}

/** Every known value, as a frozen object that only changes when a value does. */
export function useFlags(): Readonly<Record<string, boolean>> {
  const store = useStore('useFlags');
  return useSyncExternalStore(
    store ? store.client.subscribe : noopSubscribe,
    () => (store ? store.client.getAll() : EMPTY_SNAPSHOT),
    () => (store ? store.serverSnapshot : EMPTY_SNAPSHOT),
  );
}

/** Loading, ready, error — for a spinner or a diagnostic. */
export function useFlagStatus(): BrowserClientStatus {
  const store = useStore('useFlagStatus');
  return useSyncExternalStore(
    store ? store.client.subscribe : noopSubscribe,
    () => (store ? store.client.getStatus() : IDLE_STATUS),
    () => (store ? store.serverStatus : IDLE_STATUS),
  );
}

/** The underlying client, for `refresh()` or `ready()`. Null outside a provider. */
export function useFlagClient(): BrowserFlagClient | null {
  return useContext(FlagContext)?.client ?? null;
}

export type {
  BrowserClientState,
  BrowserClientStatus,
  BrowserContext,
  BrowserFlagClient,
} from '../browser/client.js';
