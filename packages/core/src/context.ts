/**
 * Limits and validation for user contexts that arrive from somewhere other
 * than a trusted server: the browser endpoint, and anything a host asks the
 * server SDK to sign.
 *
 * There is exactly one implementation, shared by the API (which rejects bad
 * input), the server SDK (which refuses to sign it) and the browser SDK (which
 * reports it before sending). That is the point of putting it here: three
 * hand-written copies of "what is a valid attribute name" would drift, and the
 * drift would surface as a context one side accepts and another rejects.
 *
 * Never throws. Every caller is on a path that must not take its host down.
 */

import type { UserContext } from './types.js';

export const CONTEXT_LIMITS = Object.freeze({
  maxUserIdLength: 256,
  maxAttributes: 32,
  maxAttributeNameLength: 64,
  maxAttributeValueLength: 256,
  maxSignedContextLength: 4096,
});

/**
 * Names that collide with object machinery. A JSON body can carry an own
 * `__proto__` key, and assigning it onto a plain object rewires the prototype
 * instead of storing a value.
 */
export const RESERVED_ATTRIBUTE_NAMES: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Flag keys as the API stores them. Browser SDKs drop any other key from a response. */
export const FLAG_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_FLAG_KEY_LENGTH = 64;

export type AttributeValue = string | number | boolean;

/**
 * A context that may be anonymous. Without a userId there is no bucket to hash
 * and the evaluator ignores targeting rules, exactly as on the server.
 */
export interface ClientContext {
  userId?: string;
  attributes?: Record<string, AttributeValue>;
}

export type ContextResult = { ok: true; context: ClientContext } | { ok: false; error: string };

/**
 * Plain-object check that also accepts objects from another realm (an iframe),
 * whose prototype is a different `Object.prototype`.
 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function readContext(input: unknown): ContextResult {
  if (input === undefined || input === null) return { ok: true, context: {} };
  if (!isObjectRecord(input)) return { ok: false, error: 'context must be an object' };

  for (const field of Object.keys(input)) {
    if (field !== 'userId' && field !== 'attributes') {
      return { ok: false, error: `unknown context field '${field}'` };
    }
  }

  const context: ClientContext = {};

  const userId = input.userId;
  if (userId !== undefined) {
    if (typeof userId !== 'string') return { ok: false, error: 'userId must be a string' };
    if (userId.length > CONTEXT_LIMITS.maxUserIdLength) {
      return { ok: false, error: `userId must be at most ${CONTEXT_LIMITS.maxUserIdLength} characters` };
    }
    // An empty or whitespace id is anonymous, as the evaluator already treats it.
    if (userId.trim().length > 0) context.userId = userId;
  }

  const attributes = input.attributes;
  if (attributes !== undefined) {
    if (!isObjectRecord(attributes)) return { ok: false, error: 'attributes must be an object' };

    const names = Object.keys(attributes);
    if (names.length > CONTEXT_LIMITS.maxAttributes) {
      return { ok: false, error: `at most ${CONTEXT_LIMITS.maxAttributes} attributes are allowed` };
    }

    const clean: Record<string, AttributeValue> = {};
    for (const name of names) {
      if (name.length === 0 || name.length > CONTEXT_LIMITS.maxAttributeNameLength) {
        return {
          ok: false,
          error: `attribute names must be 1-${CONTEXT_LIMITS.maxAttributeNameLength} characters`,
        };
      }
      if (RESERVED_ATTRIBUTE_NAMES.includes(name)) {
        return { ok: false, error: `'${name}' is not an allowed attribute name` };
      }

      const value = attributes[name];
      if (typeof value === 'string') {
        if (value.length > CONTEXT_LIMITS.maxAttributeValueLength) {
          return {
            ok: false,
            error: `attribute '${name}' must be at most ${CONTEXT_LIMITS.maxAttributeValueLength} characters`,
          };
        }
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { ok: false, error: `attribute '${name}' must be finite` };
      } else if (typeof value !== 'boolean') {
        return { ok: false, error: `attribute '${name}' must be a string, number or boolean` };
      }
      // Safe as a plain assignment: the reserved names are excluded above.
      clean[name] = value;
    }

    if (names.length > 0) context.attributes = clean;
  }

  return { ok: true, context };
}

/**
 * Validates and copies an untrusted context. The copy contains only the
 * permitted fields, so the caller never holds a reference to the input object.
 */
export function parseContext(input: unknown): ContextResult {
  try {
    return readContext(input);
  } catch {
    // A getter that throws, a revoked Proxy — anything unreadable is invalid,
    // never an exception in the caller.
    return { ok: false, error: 'context could not be read' };
  }
}

/** The evaluator's input: undefined for an anonymous context. */
export function toUserContext(context: ClientContext): UserContext | undefined {
  if (context.userId === undefined) return undefined;
  return context.attributes === undefined
    ? { userId: context.userId }
    : { userId: context.userId, attributes: context.attributes };
}

/** True when there is nothing identifying about a context. */
export function isAnonymousContext(context: ClientContext): boolean {
  return context.userId === undefined && context.attributes === undefined;
}

/**
 * A deterministic JSON form: userId first, attribute names sorted. The same
 * context always serialises — and therefore signs — identically, however the
 * host happened to build the object.
 */
export function canonicalContextJson(context: ClientContext): string {
  const ordered: ClientContext = {};
  if (context.userId !== undefined) ordered.userId = context.userId;
  if (context.attributes !== undefined) {
    const sorted: Record<string, AttributeValue> = {};
    for (const name of Object.keys(context.attributes).sort()) {
      sorted[name] = context.attributes[name]!;
    }
    ordered.attributes = sorted;
  }
  return JSON.stringify(ordered);
}
