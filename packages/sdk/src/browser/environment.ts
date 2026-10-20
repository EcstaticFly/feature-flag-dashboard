/**
 * Every browser API the browser client touches goes through here.
 *
 * Nothing at module scope reads a browser global: this file only defines
 * functions, and each looks its global up when called. That is what makes the
 * package safe to import during server rendering (Next.js renders client
 * components on the server too), in Node and in tests.
 *
 * The package builds without the DOM lib on purpose, so the compiler rejects
 * any direct `window.` reference elsewhere — the only way in is these guarded
 * accessors. Each tolerates the global being missing, and the ones that can
 * throw (localStorage, under blocked storage) are wrapped.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EventTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

interface DocumentLike extends EventTargetLike {
  visibilityState?: string;
}

interface Globals {
  window?: EventTargetLike;
  document?: DocumentLike;
  navigator?: { onLine?: boolean };
  localStorage?: StorageLike;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<unknown>;
  AbortController?: new () => { signal: unknown; abort(): void };
}

function globals(): Globals {
  return globalThis as unknown as Globals;
}

/**
 * A browser main thread: `window` and `document` both exist. False during
 * server rendering, in Node and in workers, where the client never fetches.
 */
export function isBrowser(): boolean {
  const g = globals();
  return typeof g.window === 'object' && g.window !== null && typeof g.document === 'object' && g.document !== null;
}

export function windowTarget(): EventTargetLike | undefined {
  const target = globals().window;
  return target && typeof target.addEventListener === 'function' ? target : undefined;
}

export function documentTarget(): DocumentLike | undefined {
  const doc = globals().document;
  return doc && typeof doc.addEventListener === 'function' ? doc : undefined;
}

/** True only when the page is known to be hidden. Unknown counts as visible. */
export function isHidden(): boolean {
  try {
    return globals().document?.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

/**
 * True only when the browser is sure it is offline. `navigator.onLine === true`
 * does not prove connectivity, so it never blocks a request; `false` is reliable.
 */
export function isOffline(): boolean {
  try {
    return globals().navigator?.onLine === false;
  } catch {
    return false;
  }
}

/**
 * localStorage, or null. Reading the property itself throws a SecurityError
 * when storage is blocked (browser settings, some private modes, sandboxed
 * iframes), so even the lookup is guarded.
 */
export function storageArea(): StorageLike | null {
  try {
    const area = globals().localStorage;
    return area && typeof area.getItem === 'function' && typeof area.setItem === 'function' ? area : null;
  } catch {
    return null;
  }
}

/** The global fetch, looked up at call time so a later polyfill or instrumentation is respected. */
export function globalFetch(): Globals['fetch'] {
  const f = globals().fetch;
  return typeof f === 'function' ? f : undefined;
}

export function createAbortController(): { signal: unknown; abort(): void } | undefined {
  try {
    const Ctor = globals().AbortController;
    return typeof Ctor === 'function' ? new Ctor() : undefined;
  } catch {
    return undefined;
  }
}
