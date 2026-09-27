import type { FlagConfig } from '@feature-flags/core';
import type { Redis } from 'ioredis';
import type { Db } from '../../db/client.js';
import { getFlagConfig, listSdkFlags } from '../flags/flag-service.js';
import { ensureConnected } from './redis.js';

/**
 * Two-tier flag cache.
 *
 *   L1  in-process Map   — per API instance, microseconds, invalidated by pub/sub
 *   L2  Redis            — shared by all instances, survives a process restart
 *   L3  Postgres         — the source of truth
 *
 * A mutation writes Postgres, clears both cache tiers, and PUBLISHes the changed
 * key so every *other* instance drops its L1 copy (NFR-02: ≤ 2 s propagation).
 * The TTL on both tiers is the defence-in-depth net for a pub/sub message that
 * never arrives — an instance is stale for at most `ttlSeconds`.
 *
 * Nothing here throws because of Redis. Every Redis call is individually
 * guarded: a failure logs and falls through to the next tier, so a Redis outage
 * degrades latency, not correctness (NFR-04).
 */

const ALL_KEY = 'flags:all';
const FLAG_KEY_PREFIX = 'flag:';
export const INVALIDATION_CHANNEL = 'flags:invalidate';

/** Thrown only when no tier could be reached at all — never for "not found". */
export class CacheUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'CacheUnavailableError';
  }
}

export interface FlagCacheOptions {
  /** Command connection. */
  redis: Redis;
  /**
   * Dedicated subscriber connection. ioredis puts a subscribed client into
   * subscriber mode, where ordinary commands are refused — hence two clients.
   */
  subscriber: Redis;
  db: Db;
  ttlSeconds: number;
}

export interface CacheStats {
  l1Hits: number;
  l2Hits: number;
  dbLoads: number;
}

export interface FlagCache {
  /** All live flag configs, for GET /api/sdk/flags. */
  getAll(): Promise<FlagConfig[]>;
  /** One flag config, or undefined if no such live flag exists. */
  getFlag(key: string): Promise<FlagConfig | undefined>;
  /** Drops every tier's copy and tells other instances to do the same. */
  invalidate(key: string): Promise<void>;
  /** Begins listening for invalidations from other instances. */
  start(): Promise<void>;
  close(): Promise<void>;
  stats(): CacheStats;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

function fresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
  return entry !== undefined && entry.expiresAt > Date.now();
}

export function createFlagCache({
  redis,
  subscriber,
  db,
  ttlSeconds,
}: FlagCacheOptions): FlagCache {
  const ttlMs = ttlSeconds * 1000;
  let snapshot: Entry<FlagConfig[]> | undefined;
  const flags = new Map<string, Entry<FlagConfig>>();
  const counters: CacheStats = { l1Hits: 0, l2Hits: 0, dbLoads: 0 };

  /**
   * Runs a Redis command, swallowing any failure — the next tier covers it.
   * Connects first: our clients are lazy and do not queue offline commands, so
   * an unconnected client would reject every call forever.
   */
  async function tryRedis<T>(
    client: Redis,
    label: string,
    op: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      await ensureConnected(client);
      return await op();
    } catch (err) {
      console.warn(`[flag-cache] redis ${label} failed:`, (err as Error).message);
      return undefined;
    }
  }

  function dropLocal(key?: string): void {
    snapshot = undefined;
    if (key === undefined) flags.clear();
    else flags.delete(key);
  }

  async function getAll(): Promise<FlagConfig[]> {
    if (fresh(snapshot)) {
      counters.l1Hits += 1;
      return snapshot.value;
    }

    const cached = await tryRedis(redis, 'GET flags:all', () => redis.get(ALL_KEY));
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as FlagConfig[];
        counters.l2Hits += 1;
        snapshot = { value: parsed, expiresAt: Date.now() + ttlMs };
        return parsed;
      } catch {
        console.warn('[flag-cache] discarding unparseable flags:all');
      }
    }

    try {
      const configs = await listSdkFlags(db);
      counters.dbLoads += 1;
      snapshot = { value: configs, expiresAt: Date.now() + ttlMs };
      await tryRedis(redis, 'SETEX flags:all', () =>
        redis.setex(ALL_KEY, ttlSeconds, JSON.stringify(configs)),
      );
      return configs;
    } catch (err) {
      // stale-if-error: an expired snapshot beats failing, and it beats
      // returning [] — an empty list would tell the SDK every flag vanished.
      if (snapshot) {
        console.error('[flag-cache] serving stale snapshot; database unreachable');
        return snapshot.value;
      }
      throw new CacheUnavailableError('no flag source is reachable', err);
    }
  }

  async function getFlag(key: string): Promise<FlagConfig | undefined> {
    const local = flags.get(key);
    if (fresh(local)) {
      counters.l1Hits += 1;
      return local.value;
    }

    const cached = await tryRedis(redis, `GET ${FLAG_KEY_PREFIX}${key}`, () =>
      redis.get(FLAG_KEY_PREFIX + key),
    );
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as FlagConfig;
        counters.l2Hits += 1;
        flags.set(key, { value: parsed, expiresAt: Date.now() + ttlMs });
        return parsed;
      } catch {
        console.warn(`[flag-cache] discarding unparseable ${FLAG_KEY_PREFIX}${key}`);
      }
    }

    try {
      const config = await getFlagConfig(db, key);
      counters.dbLoads += 1;
      // A missing flag is not cached. Negative caching would need invalidation
      // on create, so v1 accepts a DB hit per lookup of a non-existent key.
      if (!config) return undefined;

      flags.set(key, { value: config, expiresAt: Date.now() + ttlMs });
      await tryRedis(redis, `SETEX ${FLAG_KEY_PREFIX}${key}`, () =>
        redis.setex(FLAG_KEY_PREFIX + key, ttlSeconds, JSON.stringify(config)),
      );
      return config;
    } catch (err) {
      // Re-read rather than reusing `local`: it may have been invalidated while
      // the database call was in flight.
      const stale = flags.get(key);
      if (stale) {
        console.error(`[flag-cache] serving stale '${key}'; database unreachable`);
        return stale.value;
      }
      throw new CacheUnavailableError(`no source reachable for flag '${key}'`, err);
    }
  }

  async function invalidate(key: string): Promise<void> {
    dropLocal(key);
    await tryRedis(redis, 'DEL', () => redis.del(FLAG_KEY_PREFIX + key, ALL_KEY));
    // Other instances hold their own L1; this is what reaches them. If the
    // publish fails they stay stale until their TTL expires — bounded, not
    // permanent, which is exactly what the TTL is there for.
    await tryRedis(redis, 'PUBLISH', () => redis.publish(INVALIDATION_CHANNEL, key));
  }

  async function start(): Promise<void> {
    subscriber.on('message', (channel, message) => {
      if (channel !== INVALIDATION_CHANNEL) return;
      // The publishing instance receives its own message; harmless, it has
      // already dropped these entries.
      dropLocal(message || undefined);
    });
    await tryRedis(subscriber, 'SUBSCRIBE', () => subscriber.subscribe(INVALIDATION_CHANNEL));
  }

  async function close(): Promise<void> {
    await tryRedis(subscriber, 'UNSUBSCRIBE', () => subscriber.unsubscribe(INVALIDATION_CHANNEL));
    dropLocal();
  }

  return { getAll, getFlag, invalidate, start, close, stats: () => ({ ...counters }) };
}

// Known simplification: when flags:all expires at the same moment on N
// instances, all N reload from Postgres (a thundering herd). At this scale —
// one small query, a handful of instances — that is acceptable for v1.
// Single-flight (one in-flight load per key, the rest awaiting it) is the fix.
