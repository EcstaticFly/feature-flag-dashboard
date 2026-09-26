/**
 * @feature-flags/core — the single implementation of "is this flag on for this
 * user?", imported by both the API and the client SDK so the two can never
 * disagree. Zero runtime dependencies: this code is bundled into the published
 * SDK and ships inside consumers' apps.
 */

export {
  isSupportedOperator,
  normalizeValue,
  SUPPORTED_OPERATORS,
  type FlagConfig,
  type TargetingOperator,
  type TargetingRule,
  type UserContext,
} from './types.js';

export { BUCKET_COUNT, computeBucket, hashString } from './hash.js';

export {
  evaluateFlag,
  evaluateFlagDetailed,
  type EvaluationReason,
  type EvaluationResult,
} from './evaluate.js';
