import { useState, useEffect } from 'react';
import { MetricCard } from '../components/ui/MetricCard.jsx';
import { getRecoveryAnalytics } from '../services/api/client.js';

function formatRate(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatScore(score, decimals = 3) {
  if (score === null || score === undefined) return '—';
  return score.toFixed(decimals);
}

export function DashboardPage({ activeView, onNavigate }) {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    getRecoveryAnalytics()
      .then((response) => {
        if (isMounted) {
          setAnalytics(response?.data || null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) setLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const title = activeView === 'overview' ? 'Good morning, Alex' : activeView === 'transactions' ? 'Transactions' : 'Recovery queue';
  const op = analytics?.operational;
  const model = analytics?.model;
  const benchmark = analytics?.benchmark;

  const operationalCards = [
    {
      label: 'Action Recovery Rate',
      value: formatRate(op?.actionRecoveryRate?.rate),
      detail: `${op?.actionRecoveryRate?.successCount ?? 0} of ${op?.actionRecoveryRate?.totalEligible ?? 0} executed payment actions`,
      tone: op?.actionRecoveryRate?.rate !== null && op?.actionRecoveryRate?.rate >= 0.5 ? 'positive' : 'neutral'
    },
    {
      label: 'Transaction Resolution Rate',
      value: formatRate(op?.transactionRecoveryRate?.rate),
      detail: `${op?.transactionRecoveryRate?.recoveredCount ?? 0} of ${op?.transactionRecoveryRate?.failedTransactionCount ?? 0} failed transactions`,
      tone: op?.transactionRecoveryRate?.rate !== null && op?.transactionRecoveryRate?.rate >= 0.5 ? 'positive' : 'neutral'
    },
    {
      label: 'Retry Success Rate',
      value: formatRate(op?.retrySuccessRate?.rate),
      detail: `${op?.retrySuccessRate?.successCount ?? 0} of ${op?.retrySuccessRate?.totalEligible ?? 0} retries succeeded`,
      tone: op?.retrySuccessRate?.rate !== null && op?.retrySuccessRate?.rate >= 0.5 ? 'positive' : 'neutral'
    },
    {
      label: 'Alternate Method Rate',
      value: formatRate(op?.alternateMethodSuccessRate?.rate),
      detail: `${op?.alternateMethodSuccessRate?.successCount ?? 0} of ${op?.alternateMethodSuccessRate?.totalEligible ?? 0} alternate methods succeeded`,
      tone: op?.alternateMethodSuccessRate?.rate !== null && op?.alternateMethodSuccessRate?.rate >= 0.5 ? 'positive' : 'neutral'
    },
    {
      label: 'Escalation Rate',
      value: formatRate(op?.escalationRate?.rate),
      detail: `${op?.escalationRate?.escalateCount ?? 0} of ${op?.escalationRate?.totalRecommendations ?? 0} recommendations escalated`,
      tone: op?.escalationRate?.rate !== null && op?.escalationRate?.rate > 0.3 ? 'warning' : 'neutral'
    }
  ];

  const intelligenceCards = [
    {
      label: 'ML Prediction Confidence',
      value: formatRate(model?.predictionConfidence?.mean),
      detail: `Mean probability (${model?.predictionConfidence?.sampleCount ?? 0} decisions, median: ${formatRate(model?.predictionConfidence?.median)})`,
      tone: 'positive'
    },
    {
      label: 'ML Calibration (Brier Score)',
      value: formatScore(model?.runtimePerformance?.brierScore),
      detail: `${model?.runtimePerformance?.sampleCount ?? 0} evaluated (accuracy: ${formatRate(model?.runtimePerformance?.accuracy)})`,
      tone: 'neutral'
    },
    {
      label: 'Rule vs ML Benchmark Lift',
      value: benchmark?.metrics?.improvement?.absolute_percentage_points !== undefined
        ? `+${benchmark.metrics.improvement.absolute_percentage_points} pp`
        : '—',
      detail: `ML: ${formatRate(benchmark?.metrics?.ml_policy?.recovery_success_rate)} vs Rule: ${formatRate(benchmark?.metrics?.rule_engine?.recovery_success_rate)} (1,200 test scenarios)`,
      tone: 'positive'
    },
    {
      label: 'Runtime ML Traffic Share',
      value: formatRate(model?.trafficShare?.mlShare),
      detail: `${model?.trafficShare?.mlCount ?? 0} ML decisions / ${model?.trafficShare?.ruleCount ?? 0} Rule fallbacks`,
      tone: 'neutral'
    }
  ];

  return (
    <div className="page-wrap">
      <header className="topbar">
        <div className="breadcrumbs">
          <span>Workspace</span>
          <span>/</span>
          <strong>{activeView === 'overview' ? 'Overview' : title}</strong>
        </div>
        <div className="topbar-actions">
          <span className="live-indicator"><span /> Systems operational</span>
          <button className="icon-button" type="button" aria-label="Notifications">!</button>
          <span className="topbar-avatar">AK</span>
        </div>
      </header>

      <section className="page-intro">
        <div>
          <p className="eyebrow">Recovery Analytics & Intelligence</p>
          <h1>{title}</h1>
          <p className="intro-copy">Live operational recovery outcomes, runtime ML calibration, and offline benchmark performance.</p>
        </div>
        {activeView === 'overview' ? (
          <button className="primary-button" type="button" onClick={() => onNavigate('create')}>
            Create transaction <span>+</span>
          </button>
        ) : (
          <button className="date-button" type="button">Last 30 days <span>v</span></button>
        )}
      </section>

      <section className="analytics-section">
        <span className="eyebrow">Durable Operational Outcomes</span>
        <div className="metric-grid" aria-label="Operational recovery metrics">
          {operationalCards.map((item) => (
            <MetricCard key={item.label} {...item} />
          ))}
        </div>
      </section>

      <section className="analytics-section" style={{ marginTop: '24px' }}>
        <span className="eyebrow">Machine Learning & Decision Analytics</span>
        <div className="metric-grid" aria-label="Machine learning metrics">
          {intelligenceCards.map((item) => (
            <MetricCard key={item.label} {...item} />
          ))}
        </div>
      </section>

      <section className="foundation-panel" style={{ marginTop: '30px' }}>
        <div className="panel-accent" />
        <div>
          <span className="panel-kicker">Closed Feedback Loop Active</span>
          <h2>Model & Recovery Analytics Cockpit (Task 6.11)</h2>
          <p>
            Operational payment outcomes are captured reliably via PostgreSQL. ML predictions and calibration are computed
            from runtime feedback buffers without altering database schema.
          </p>
        </div>
        <span className="panel-status">Phase 2 / 6.11</span>
      </section>
    </div>
  );
}
