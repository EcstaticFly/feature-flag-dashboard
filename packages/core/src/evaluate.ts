import { computeBucket } from './hash.js';
import {
  isSupportedOperator,
  normalizeValue,
  type FlagConfig,
  type TargetingRule,
  type UserContext,
} from './types.js';

/**
 * Flag evaluation (FR-03, FR-04, FR-05).
 *
 * Pure: same inputs, same output, no I/O. The API serves `/evaluate` with this
 * and the SDK evaluates locally with the very same code, so the two can never
 * disagree about a user.
 *
 * Defensive by design: flag configs arrive over the network from an API that
 * may be newer than the SDK reading them, so anything unrecognised is SKIPPED
 * rather than thrown on. A feature-flag check must never take down its host app.
 */

export type EvaluationReason =
  /** The flag is off; nothing else is considered. */
  | 'kill_switch'
  /** No stable user id, so the flag's plain on/off state is used. */
  | 'anonymous'
  /** A targeting rule matched. */
  | 'rule_match'
  /** The user's bucket fell inside the rollout percentage. */
  | 'rollout_in'
  /** The user's bucket fell outside the rollout percentage. */
  | 'rollout_out';

export interface EvaluationResult {
  enabled: boolean;
  reason: EvaluationReason;
  /** Index of the rule that matched, when `reason` is `rule_match`. */
  ruleIndex?: number;
  /** The user's 0-99 bucket, when the percentage decided the outcome. */
  bucket?: number;
}

/**
 * Reads the attribute a rule targets. `userId` comes from the context's own id
 * rather than its attribute bag: it is the identifier the bucket hashes, so an
 * allowlist must agree with it. Returns undefined when the attribute is absent,
 * which makes the rule inapplicable rather than false.
 */
function resolveAttribute(context: UserContext, attribute: string): string | undefined {
  const raw = attribute === 'userId' ? context.userId : context.attributes?.[attribute];
  if (raw === undefined || raw === null) return undefined;
  return normalizeValue(raw);
}

/**
 * Whether a rule matches. An unusable rule — unknown operator, malformed
 * values, or an attribute this user doesn't have — is simply not a match, so
 * evaluation continues with the next rule.
 */
function ruleMatches(rule: TargetingRule, context: UserContext): boolean {
  if (typeof rule !== 'object' || rule === null) return false;
  if (typeof rule.attribute !== 'string' || rule.attribute.length === 0) return false;
  if (!isSupportedOperator(rule.operator)) return false;
  if (!Array.isArray(rule.values) || rule.values.length === 0) return false;

  const actual = resolveAttribute(context, rule.attribute);
  if (actual === undefined) return false;

  if (rule.operator === 'in') {
    return rule.values.some((value) => normalizeValue(value) === actual);
  }
  // 'eq' — validation guarantees exactly one value.
  return normalizeValue(rule.values[0]!) === actual;
}

/**
 * Evaluates a flag and explains why. Order is deliberate:
 *
 *   1. kill switch — an off flag is off for everyone, allowlists included.
 *   2. anonymous   — no stable id means no bucket and no attributes to target.
 *   3. targeting   — a matched rule beats the percentage, so specific users can
 *                    be let in ahead of a rollout.
 *   4. percentage  — deterministic bucket vs. the configured share.
 */
export function evaluateFlagDetailed(
  flag: FlagConfig,
  context?: UserContext,
): EvaluationResult {
  if (!flag.enabled) {
    return { enabled: false, reason: 'kill_switch' };
  }

  const userId = context?.userId;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    // Consequence worth knowing: anonymous traffic sees an enabled flag in full,
    // regardless of its rollout percentage.
    return { enabled: flag.enabled, reason: 'anonymous' };
  }

  const rules = Array.isArray(flag.targetingRules) ? flag.targetingRules : [];
  for (let i = 0; i < rules.length; i += 1) {
    if (ruleMatches(rules[i]!, context!)) {
      return { enabled: true, reason: 'rule_match', ruleIndex: i };
    }
  }

  const bucket = computeBucket(userId, flag.key);
  const inRollout = bucket < flag.rolloutPercentage;
  return { enabled: inRollout, reason: inRollout ? 'rollout_in' : 'rollout_out', bucket };
}

/**
 * The SDK's `isEnabled` surface (FR-07): just the answer.
 * Percentages are validated at the API layer and by a database CHECK
 * constraint, so nothing is clamped here.
 */
export function evaluateFlag(flag: FlagConfig, context?: UserContext): boolean {
  return evaluateFlagDetailed(flag, context).enabled;
}
