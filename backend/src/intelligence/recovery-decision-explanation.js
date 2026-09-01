import {
  buildDecisionAuditRecord,
  SAFETY_REJECTION_REASONS,
  AUDIT_SCHEMA_VERSION,
  DECISION_POLICY_VERSION
} from './recovery-decision-audit-service.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from './recovery-decision-policy.js';
import { FEATURE_SCHEMA_VERSION, FEATURE_PIPELINE_VERSION } from './recovery-feature-pipeline.js';

export const EXPLANATION_SCHEMA_VERSION = '6.8.0';

export const REASON_TYPES = Object.freeze({
  MODEL_RANKING: 'MODEL_RANKING',
  SAFETY_VERIFICATION: 'SAFETY_VERIFICATION',
  SAFETY_REJECTION: 'SAFETY_REJECTION',
  RULE_FALLBACK: 'RULE_FALLBACK',
  RULE_DETERMINATION: 'RULE_DETERMINATION'
});

const REJECTION_DESCRIPTIONS = Object.freeze({
  [SAFETY_REJECTION_REASONS.RETRY_LIMIT_EXCEEDED]: 'The maximum retry limit of 2 temporary attempts has been reached.',
  [SAFETY_REJECTION_REASONS.RETRY_NOT_APPLICABLE_FOR_CATEGORY]: 'Retrying the payment is only permitted for temporary failures.',
  [SAFETY_REJECTION_REASONS.NO_SAFE_ALTERNATE_METHOD]: 'No different, valid payment method is available to attempt.',
  [SAFETY_REJECTION_REASONS.ACTION_ALREADY_EXECUTED]: 'This recovery action has already been executed for this transaction.',
  [SAFETY_REJECTION_REASONS.TRANSACTION_NOT_FAILED]: 'Transaction is not in a failed state.'
});

const FALLBACK_DESCRIPTIONS = Object.freeze({
  [FALLBACK_REASONS.MODEL_UNAVAILABLE]: 'The machine learning prediction service was unavailable or encountered an error.',
  [FALLBACK_REASONS.INVALID_PREDICTION]: 'The machine learning model output was malformed or failed validation.',
  [FALLBACK_REASONS.NO_SAFE_CANDIDATE]: 'All high-probability machine learning candidates were disqualified by business safety rules.'
});

function formatPercentage(prob) {
  if (prob === null || prob === undefined || typeof prob !== 'number') return 'N/A';
  return `${(prob * 100).toFixed(2)}%`;
}

function buildHumanReadableText({ selectedAction, decisionSource, selectedProbability, fallback, candidates, rejectedCandidates, context }) {
  if (decisionSource === DECISION_SOURCES.ML) {
    const probText = selectedProbability !== null ? ` (estimated recovery probability: ${formatPercentage(selectedProbability)})` : '';
    const safeCount = candidates.filter((c) => c.is_safe).length;
    let text = `${selectedAction} was recommended based on machine learning scoring${probText} as the highest-probability safe recovery action among ${safeCount} eligible candidate(s).`;
    
    if (rejectedCandidates && rejectedCandidates.length > 0) {
      const rejectedList = rejectedCandidates.map((c) => `${c.action_type} (${REJECTION_DESCRIPTIONS[c.rejection_reason] ?? c.rejection_reason})`).join('; ');
      text += ` Rejected candidate(s): ${rejectedList}.`;
    }
    return text;
  }

  // RULE Fallback
  const fallbackReasonText = FALLBACK_DESCRIPTIONS[fallback?.fallback_reason] ?? fallback?.fallback_reason ?? 'ML decision was bypassed';
  let text = `${selectedAction} was selected by Phase 1 deterministic rules because ${fallbackReasonText}.`;
  if (fallback?.rule_reason) {
    text += ` Rule justification: ${fallback.rule_reason}`;
  }
  return text;
}

export function explainDecision(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Input is required to generate an explanation.');
  }

  // If input is already an audit record (or contains decision/context)
  const auditRecord = input.audit_schema_version
    ? input
    : (input.auditRecord ?? input.audit_record ?? buildDecisionAuditRecord({
        decision: input.decision,
        context: input.context,
        correlation: input.correlation,
        decisionTimestamp: input.decisionTimestamp,
        decisionLatencyMs: input.decisionLatencyMs
      }));

  const {
    selected_action: selectedAction,
    decision_source: decisionSource,
    decision_reason: decisionReason,
    selected_probability: selectedProbability,
    candidates = [],
    rejected_candidates: rejectedCandidates = [],
    fallback,
    context = {},
    versions = {}
  } = auditRecord;

  if (!selectedAction || !decisionSource) {
    throw new Error('Audit record must contain valid selected_action and decision_source.');
  }

  const isML = decisionSource === DECISION_SOURCES.ML;

  // Build candidate comparison with ranking
  const sortedCandidates = [...candidates].sort((a, b) => {
    const pA = typeof a.ml_probability === 'number' ? a.ml_probability : -1;
    const pB = typeof b.ml_probability === 'number' ? b.ml_probability : -1;
    return pB - pA;
  });

  const candidateComparison = sortedCandidates.map((c, index) => {
    let status = 'CONSIDERED';
    if (c.action_type === selectedAction) {
      status = 'SELECTED';
    } else if (!c.is_safe) {
      status = 'REJECTED_BY_SAFETY';
    } else if (isML) {
      status = 'CONSIDERED_LOWER_PROBABILITY';
    }

    return {
      action: c.action_type,
      predicted_recovery_probability: c.ml_probability,
      rank: isML && typeof c.ml_probability === 'number' ? index + 1 : null,
      is_safe: c.is_safe,
      rejection_reason: c.rejection_reason ?? null,
      status
    };
  });

  // Build granular reasons array
  const reasons = [];

  if (isML) {
    reasons.push({
      type: REASON_TYPES.MODEL_RANKING,
      message: `${selectedAction} had the highest predicted recovery probability (${formatPercentage(selectedProbability)}) among all safe candidates.`,
      action: selectedAction,
      predicted_recovery_probability: selectedProbability
    });

    reasons.push({
      type: REASON_TYPES.SAFETY_VERIFICATION,
      message: `${selectedAction} satisfied all operational safety constraints for the ${context.failure_category ?? 'current'} failure context.`,
      action: selectedAction
    });
  } else {
    reasons.push({
      type: REASON_TYPES.RULE_FALLBACK,
      message: `Fallback to Phase 1 deterministic rules was engaged because: ${FALLBACK_DESCRIPTIONS[fallback?.fallback_reason] ?? fallback?.fallback_reason ?? 'RULE_DECISION_SOURCE'}.`,
      fallback_reason: fallback?.fallback_reason ?? null,
      fallback_error: fallback?.fallback_error ?? null
    });

    reasons.push({
      type: REASON_TYPES.RULE_DETERMINATION,
      message: decisionReason || `Phase 1 rule engine evaluated ${selectedAction}.`,
      action: selectedAction
    });
  }

  // Add rejection reasons if any candidate was filtered
  for (const rejected of rejectedCandidates) {
    reasons.push({
      type: REASON_TYPES.SAFETY_REJECTION,
      message: `${rejected.action_type} was excluded because: ${REJECTION_DESCRIPTIONS[rejected.rejection_reason] ?? rejected.rejection_reason}.`,
      action: rejected.action_type,
      rejection_reason: rejected.rejection_reason,
      predicted_recovery_probability: rejected.ml_probability ?? null
    });
  }

  const structuredExplanation = {
    explanation_schema_version: EXPLANATION_SCHEMA_VERSION,
    selected_action: selectedAction,
    decision_source: decisionSource,
    summary: decisionReason || (isML ? `${selectedAction} selected via ML policy.` : `${selectedAction} selected via Rule fallback.`),
    human_readable_text: buildHumanReadableText({
      selectedAction,
      decisionSource,
      selectedProbability,
      fallback: { ...fallback, rule_reason: decisionReason },
      candidates,
      rejectedCandidates,
      context
    }),
    reasons,
    candidate_comparison: candidateComparison,
    rejected_candidates: rejectedCandidates.map((r) => ({
      action: r.action_type,
      predicted_recovery_probability: r.ml_probability ?? null,
      rejection_reason: r.rejection_reason,
      explanation: REJECTION_DESCRIPTIONS[r.rejection_reason] ?? r.rejection_reason
    })),
    fallback: isML
      ? null
      : {
          is_fallback: true,
          fallback_reason: fallback?.fallback_reason ?? null,
          fallback_error: fallback?.fallback_error ?? null,
          rule_reason: decisionReason
        },
    context_summary: {
      failure_category: context.failure_category ?? null,
      payment_method_attempted: context.payment_method_attempted ?? null,
      attempt_number: context.attempt_number ?? 1,
      prior_failed_attempt_count: context.prior_failed_attempt_count ?? 0,
      prior_temporary_failure_count: context.prior_temporary_failure_count ?? 0
    },
    versions: {
      model_version: versions.model_version ?? null,
      feature_schema_version: versions.feature_schema_version ?? FEATURE_SCHEMA_VERSION,
      feature_pipeline_version: versions.feature_pipeline_version ?? FEATURE_PIPELINE_VERSION,
      policy_version: versions.policy_version ?? DECISION_POLICY_VERSION,
      explanation_schema_version: EXPLANATION_SCHEMA_VERSION
    }
  };

  return Object.freeze(structuredExplanation);
}

export class RecoveryDecisionExplanationService {
  explain(input) {
    return explainDecision(input);
  }
}
