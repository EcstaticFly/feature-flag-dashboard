/**
 * Deterministic bucketing hash.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ FROZEN CONTRACT — do not change anything in this file.                  │
 * │                                                                         │
 * │ The input format, the constants and the mixing steps below all feed     │
 * │ into which 0-99 bucket a user lands in. Changing any of them reshuffles │
 * │ EVERY user into a new bucket, which flips people between variants       │
 * │ mid-rollout for no visible reason. The golden tests in                  │
 * │ tests/bucket.test.ts exist to make such a change impossible to merge.   │
 * │                                                                         │
 * │ The same values must also be produced by the API and by the SDK, which  │
 * │ both import this module — that is why it lives in @feature-flags/core   │
 * │ and uses no imports of its own (so it runs in Node, a browser or an     │
 * │ edge runtime identically).                                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over UTF-16 code units. `Math.imul` performs the 32-bit multiply
 * exactly; a plain `*` would lose precision above 2^53 and give different
 * results for longer inputs.
 */
function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * MurmurHash3's final avalanche. FNV-1a alone disperses its high bits well but
 * leaves patterns in the low bits — and `% 100` reads exactly those, so
 * sequential ids like `user_1`, `user_2` would clump without this step.
 */
function fmix32(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hashes a string to an unsigned 32-bit integer. */
export function hashString(input: string): number {
  return fmix32(fnv1a32(input));
}

/** How many buckets the 0-100% rollout space is divided into. */
export const BUCKET_COUNT = 100;

/**
 * Maps a user to a stable bucket in 0..99 for one flag (FR-05).
 *
 * The flag key is part of the hash input, so the same user sits in a different
 * bucket for every flag — otherwise a user with a low bucket would be in the
 * first slice of every rollout and a high-bucket user in none of them.
 *
 * Because the bucket is stable, raising a rollout only ever ADDS users: someone
 * at bucket 12 is in at 25% and still in at 50%. Lowering it only removes.
 */
export function computeBucket(userId: string, flagKey: string): number {
  return hashString(`${flagKey}:${userId}`) % BUCKET_COUNT;
}
