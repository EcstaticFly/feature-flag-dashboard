import { FLAG_KEY_PATTERN, MAX_FLAG_KEY_LENGTH } from '@feature-flags/core';

/**
 * Flag snapshots: what the browser client holds and hands to the page.
 *
 * Always a frozen, null-prototype object. Null-prototype because a host page
 * with a polluted `Object.prototype` (`Object.prototype.beta = true`, from a
 * vulnerable dependency) must not make an unknown flag read as enabled.
 * Frozen because the same object is handed to every caller, and React's
 * `useSyncExternalStore` relies on it never changing in place.
 */

export type FlagSnapshot = Readonly<Record<string, boolean>>;

/** More flags than this in one response is treated as a bug, not data. */
export const MAX_FLAGS = 2000;

export const EMPTY_SNAPSHOT: FlagSnapshot = Object.freeze(Object.create(null) as Record<string, boolean>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Builds a snapshot from untrusted data — a response body, `initialFlags`, or
 * storage. Keeps only boolean values under well-formed flag keys; anything
 * else is dropped rather than trusted. Returns null if the shape is wrong.
 */
export function toSnapshot(source: unknown): FlagSnapshot | null {
  if (!isRecord(source)) return null;
  const out = Object.create(null) as Record<string, boolean>;
  let count = 0;
  for (const key of Object.keys(source)) {
    if (count >= MAX_FLAGS) break;
    if (key.length === 0 || key.length > MAX_FLAG_KEY_LENGTH || !FLAG_KEY_PATTERN.test(key)) continue;
    const value = source[key];
    if (typeof value !== 'boolean') continue;
    out[key] = value;
    count += 1;
  }
  return Object.freeze(out);
}

/** Reads `{ flags: {...} }`, the browser endpoint's response shape. */
export function snapshotFromResponse(body: unknown): FlagSnapshot | null {
  return isRecord(body) ? toSnapshot(body.flags) : null;
}

/** Same keys and values. Lets an unchanged refresh keep the existing object. */
export function sameSnapshot(a: FlagSnapshot, b: FlagSnapshot): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) return false;
  }
  return true;
}

export function hasFlag(snapshot: FlagSnapshot, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot, key);
}
