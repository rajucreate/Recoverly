import { useState } from 'react';

function formatProbability(prob) {
  if (prob === null || prob === undefined || typeof prob !== 'number') return 'N/A';
  return `${(prob * 100).toFixed(1)}%`;
}

export function DecisionExplanationCard({ explanation }) {
  const [showComparison, setShowComparison] = useState(false);

  if (!explanation) return null;

  const isML = explanation.decision_source === 'ML';
  const isFallback = explanation.fallback?.is_fallback;
  const selectedCandidate = explanation.candidate_comparison?.find((c) => c.status === 'SELECTED' || c.action === explanation.selected_action);
  const selectedProb = selectedCandidate?.predicted_recovery_probability;

  return (
    <div className="explanation-card">
      <div className="explanation-header">
        <div className="explanation-badges">
          <span className={`decision-badge ${isML ? 'badge-ml' : 'badge-rule'}`}>
            {isML ? 'ML Recommendation' : 'Rule Fallback'}
          </span>
          <span className="action-pill">{explanation.selected_action}</span>
        </div>
        {isML && typeof selectedProb === 'number' && (
          <div className="probability-stat">
            <span className="probability-number">{formatProbability(selectedProb)}</span>
            <span className="probability-label">estimated probability</span>
          </div>
        )}
      </div>

      <p className="explanation-narrative">{explanation.human_readable_text}</p>

      {isFallback && (
        <div className="fallback-banner">
          <div className="fallback-banner-header">
            <strong>Rule Engine Fallback Engaged</strong>
            <span className="fallback-reason-code">{explanation.fallback.fallback_reason}</span>
          </div>
          {explanation.fallback.rule_reason && (
            <p className="fallback-banner-copy">{explanation.fallback.rule_reason}</p>
          )}
        </div>
      )}

      {explanation.rejected_candidates && explanation.rejected_candidates.length > 0 && (
        <div className="rejection-box">
          <span className="eyebrow rejection-eyebrow">Safety Constraints Applied</span>
          <ul className="rejection-list">
            {explanation.rejected_candidates.map((rejected) => (
              <li key={rejected.action} className="rejection-item">
                <strong>{rejected.action}:</strong> {rejected.explanation}
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.candidate_comparison && explanation.candidate_comparison.length > 0 && (
        <div className="comparison-section">
          <button
            type="button"
            className="comparison-toggle-button"
            onClick={() => setShowComparison((prev) => !prev)}
            aria-expanded={showComparison}
          >
            <span>{showComparison ? 'Hide candidate comparison' : 'View candidate comparison & rankings'}</span>
            <span className="toggle-icon">{showComparison ? '▲' : '▼'}</span>
          </button>

          {showComparison && (
            <div className="comparison-table-wrapper">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Est. Probability</th>
                    <th>Rank</th>
                    <th>Status</th>
                    <th>Safety Note</th>
                  </tr>
                </thead>
                <tbody>
                  {explanation.candidate_comparison.map((candidate) => (
                    <tr
                      key={candidate.action}
                      className={candidate.status === 'SELECTED' ? 'row-selected' : ''}
                    >
                      <td>
                        <strong>{candidate.action}</strong>
                      </td>
                      <td>{formatProbability(candidate.predicted_recovery_probability)}</td>
                      <td>{candidate.rank !== null ? `#${candidate.rank}` : '—'}</td>
                      <td>
                        <span className={`status-pill status-${candidate.status.toLowerCase().replace(/_/g, '-')}`}>
                          {candidate.status === 'SELECTED'
                            ? 'Selected'
                            : candidate.status === 'REJECTED_BY_SAFETY'
                            ? 'Safety Rejection'
                            : 'Lower Probability'}
                        </span>
                      </td>
                      <td className="rejection-cell">
                        {candidate.rejection_reason || 'Passed all safety checks'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <small className="probability-disclaimer">
                * Estimated recovery probability is a model prediction derived from historical failure patterns, not an outcome guarantee.
              </small>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
