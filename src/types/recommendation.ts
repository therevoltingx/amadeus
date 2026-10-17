/**
 * Recommendation system: advisory only, no auto-apply.
 * Source-agnostic (agent / human / system), auditable, UI-visible.
 *
 * Domain constants/types are duplicated in `agents/recommending-agent.ts` (inlined module);
 * keep both copies aligned when changing scopes, sources, types, or CreateRecommendationInput.
 */

export const RECOMMENDATION_SCOPES = ['policy', 'account', 'global'] as const;
export const RECOMMENDATION_SOURCES = ['agent', 'human', 'system'] as const;
export const RECOMMENDATION_TYPES = ['policy_variant', 'new_policy', 'warning', 'suggestion'] as const;

/** Stored in recommendations.policy_version when the recommendation is for a brand-new policy (not based on an existing one). */
export const NEW_POLICY_RECOMMENDATION_BASE = '__new__';
export const RECOMMENDATION_STATUSES = ['pending', 'accepted', 'rejected', 'expired'] as const;

export type RecommendationScope = (typeof RECOMMENDATION_SCOPES)[number];
export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export interface CreateRecommendationInput {
  /** Required for policy_variant; omit or empty for new_policy (stored as NEW_POLICY_RECOMMENDATION_BASE). */
  policyVersion?: string;
  scope: RecommendationScope;
  source: RecommendationSource;
  sourceId?: string | null;
  recommendationType: RecommendationType;
  payload: Record<string, unknown>;
  confidence?: number | null;
  rationale?: string | null;
  /** Optional changelog text applied to the new policy when the recommendation is accepted. */
  changelog?: string | null;
  /**
   * For policy_variant / new_policy: proposed **policy_version** for the new policy.
   * Must match the version string in the new changelog heading `## [name] - YYYY-MM-DD`.
   */
  name?: string | null;
}
