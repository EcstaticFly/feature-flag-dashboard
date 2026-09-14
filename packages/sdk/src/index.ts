/**
 * Attributes describing the user a flag is evaluated for (FR-04).
 * Exact rule semantics are defined by the API's targeting service.
 */
export interface UserContext {
  userId: string;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Placeholder — the real implementation (cached evaluation, pub/sub
 * invalidation) arrives in a later milestone.
 */
export function isEnabled(_flagKey: string, _context: UserContext): boolean {
  throw new Error('@feature-flags/sdk: isEnabled is not implemented yet');
}
