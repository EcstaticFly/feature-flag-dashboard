import { hashString } from '@feature-flags/core';
import { storageArea } from './environment.js';
import { toSnapshot, type FlagSnapshot } from './snapshot.js';

/**
 * Optional last-known-values cache in localStorage (`persist: true`).
 *
 * Off by default. When on, it lets a single-page app paint the right values
 * on a reload, before the network answers.
 *
 * - One entry per client key, so storage never grows. It is tagged with a hash
 *   of the identity and used only when that matches, so a shared computer can
 *   never show one user's flags to the next person who signs in.
 * - Entries older than seven days are ignored.
 * - Every access is guarded: blocked storage (a SecurityError on even reading
 *   the property), a full quota, or a corrupt entry all mean "no cache", never
 *   an error. In a private window the entry simply ends with the session.
 * - No identifier is ever created here. The only stored values are flag
 *   booleans and two hashes.
 */

const VERSION = 1;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredEntry {
  v: number;
  /** Identity hash. */
  i: string;
  /** Saved at, epoch ms. */
  t: number;
  /** The flags. */
  f: unknown;
}

/**
 * 64 bits from two 32-bit hashes. A collision would mean one identity's
 * cached booleans briefly showing for another, before the refetch replaced them.
 */
function hash64(input: string): string {
  return hashString(input).toString(36) + hashString(`${input}#`).toString(36);
}

export function storageKeyFor(clientKey: string): string {
  return `flagpilot:v${VERSION}:${hash64(clientKey)}`;
}

export function loadPersisted(clientKey: string, identityKey: string): FlagSnapshot | null {
  const area = storageArea();
  if (!area) return null;
  try {
    const raw = area.getItem(storageKeyFor(clientKey));
    if (raw === null || raw.length > 512 * 1024) return null;
    const entry = JSON.parse(raw) as Partial<StoredEntry> | null;
    if (!entry || entry.v !== VERSION || entry.i !== hash64(identityKey)) return null;
    if (typeof entry.t !== 'number') return null;
    const age = Date.now() - entry.t;
    if (age < 0 || age > MAX_AGE_MS) return null;
    return toSnapshot(entry.f);
  } catch {
    return null;
  }
}

export function savePersisted(clientKey: string, identityKey: string, flags: FlagSnapshot): void {
  const area = storageArea();
  if (!area) return;
  try {
    const entry: StoredEntry = { v: VERSION, i: hash64(identityKey), t: Date.now(), f: flags };
    area.setItem(storageKeyFor(clientKey), JSON.stringify(entry));
  } catch {
    // Quota exceeded, or storage blocked after the lookup: the cache is a
    // convenience, so losing a write costs nothing.
  }
}
