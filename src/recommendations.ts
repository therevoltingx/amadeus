import { db } from './db.js';
import { NEW_POLICY_RECOMMENDATION_BASE } from './types/recommendation.js';
import type { CreateRecommendationInput } from './types/recommendation.js';

/**
 * Creates a recommendation (advisory only; no policy mutation).
 * status = 'pending', created_at = now(). No validation beyond schema shape.
 * For recommendation_type 'new_policy', policyVersion may be omitted (stored as __new__).
 */
export function createRecommendation(input: CreateRecommendationInput): number {
  const now = Math.floor(Date.now() / 1000);
  const payloadJson = JSON.stringify(input.payload);
  const policyVersion =
    input.recommendationType === 'new_policy'
      ? (input.policyVersion?.trim() || NEW_POLICY_RECOMMENDATION_BASE)
      : (input.policyVersion ?? '');
  const result = db
    .prepare(
      `INSERT INTO recommendations (
        policy_version, scope, source, source_id, recommendation_type,
        payload, confidence, status, rationale, changelog, name, created_at
      ) VALUES ($policyVersion, $scope, $source, $sourceId, $recommendationType, $payload, $confidence, 'pending', $rationale, $changelog, $name, $createdAt)`
    )
    .run({
      policyVersion,
      scope: input.scope,
      source: input.source,
      sourceId: input.sourceId ?? null,
      recommendationType: input.recommendationType,
      payload: payloadJson,
      confidence: input.confidence ?? null,
      rationale: input.rationale ?? null,
      changelog: input.changelog ?? null,
      name:
        input.name != null && String(input.name).trim() !== ''
          ? String(input.name).trim()
          : null,
      createdAt: now,
    });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}
