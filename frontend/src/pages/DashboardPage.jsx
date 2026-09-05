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

function formatMoney(amount, currency = 'INR') {
  if (amount === null || amount === undefined) return '—';
  const num = Number.parseFloat(amount);
  if (Number.isNaN(num)) return '—';
  const symbol = currency === 'INR' ? '₹' : (currency === 'USD' ? '$' : (currency ? `${currency} ` : ''));
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DashboardPage({ activeView, onNavigate }) {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [batchInput, setBatchInput] = useState('');
  const [appliedBatch, setAppliedBatch] = useState(null);
  const [batchError, setBatchError] = useState(null);

  const fetchAnalytics = (transactionIds = null) => {
    setLoading(true);
    setBatchError(null);
    getRecoveryAnalytics(transactionIds ? { transactionIds } : {})
      .then((response) => {
        setAnalytics(response?.data || null);
        setLoading(false);
      })
      .catch((err) => {
        setBatchError(err.message || 'Failed to fetch recovery analytics');
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const handleApplyBatch = (e) => {
    e.preventDefault();
    const trimmed = batchInput.trim();
    if (!trimmed) {
      setAppliedBatch(null);
      fetchAnalytics(null);
      return;
    }
    setAppliedBatch(trimmed);
    fetchAnalytics(trimmed);
  };

  const handleClearBatch = () => {
    setBatchInput('');
    setAppliedBatch(null);
    fetchAnalytics(null);
  };

  const title = activeView === 'overview' ? 'Good morning, Alex' : activeView === 'transactions' ? 'Transactions' : 'Recovery queue';
  const op = analytics?.operational;
  const monetary = op?.monetary;
  const model = analytics?.model;
  const benchmark = analytics?.benchmark;

  const monetaryCards = [
    {
      label: 'Revenue Recovered',
      value: formatMoney(monetary?.revenueRecovered, monetary?.currency),
      detail: `Monetary Recovery Rate: ${formatRate(monetary?.monetaryRecoveryRate)}`,
      tone: 'positive'
    },
    {
      label: 'Revenue at Risk',
      value: formatMoney(monetary?.revenueAtRisk, monetary?.currency),
      detail: `${op?.transactionRecoveryRate?.failedTransactionCount ?? 0} failed transactions in scope`,
      tone: 'neutral'
    },
    {
      label: 'Monetary Recovery Rate',
      value: formatRate(monetary?.monetaryRecoveryRate),
      detail: `${monetary?.successfulRecoveries ?? 0} recovered of ${monetary?.revenueAtRisk ? formatMoney(monetary?.revenueAtRisk, monetary?.currency) : '—'}`,
      tone: monetary?.monetaryRecoveryRate !== null && monetary?.monetaryRecoveryRate >= 0.5 ? 'positive' : 'neutral'
    },
    {
      label: 'Recovery Outcomes',
      value: `${monetary?.successfulRecoveries ?? 0} Recovered`,
      detail: `${monetary?.failedRecoveries ?? 0} failed / ${monetary?.stoppedRecoveries ?? 0} stopped / ${monetary?.pendingRecoveries ?? 0} pending`,
      tone: monetary?.successfulRecoveries ? 'positive' : 'neutral'
    }
  ];

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
          <p className="eyebrow">Recovery Analytics & Monetary Intelligence</p>
          <h1>{title}</h1>
          <p className="intro-copy">Measured revenue recovery evaluation across payment failure batches, ML calibration, and operational outcomes.</p>
        </div>
        {activeView === 'overview' ? (
          <button className="primary-button" type="button" onClick={() => onNavigate('create')}>
            Create transaction <span>+</span>
          </button>
        ) : (
          <button className="date-button" type="button">Last 30 days <span>v</span></button>
        )}
      </section>

      {/* Batch Selector */}
      <section style={{ marginBottom: '24px', padding: '16px 20px', background: '#fff', border: '1px solid var(--line)', borderRadius: '9px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <span className="eyebrow" style={{ margin: 0 }}>Batch Evaluation Scope</span>
            <p style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '3px' }}>
              {appliedBatch
                ? `Evaluating batch scope: ${analytics?.batch?.transactionIds?.length ?? 'Selected'} transaction(s)`
                : 'Evaluating full transaction scope (all transactions)'}
            </p>
          </div>
          <form onSubmit={handleApplyBatch} style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: '1', maxWidth: '650px', justifyContent: 'flex-end' }}>
            <input
              type="text"
              placeholder="Paste comma-separated transaction UUIDs (e.g. id1, id2)..."
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              style={{ flex: 1, padding: '9px 12px', border: '1px solid var(--line)', borderRadius: '6px', fontSize: '12px', background: '#fbfcfa', color: 'var(--ink)' }}
            />
            <button className="primary-button" type="submit" disabled={loading} style={{ padding: '9px 15px', whiteSpace: 'nowrap' }}>
              {loading ? 'Evaluating...' : 'Evaluate Batch'}
            </button>
            {appliedBatch && (
              <button className="secondary-button" type="button" onClick={handleClearBatch} disabled={loading} style={{ padding: '9px 13px', whiteSpace: 'nowrap' }}>
                Reset
              </button>
            )}
          </form>
        </div>
        {batchError && (
          <div style={{ marginTop: '10px', padding: '8px 12px', background: '#fff0ea', borderLeft: '3px solid #d56c45', color: '#91492d', fontSize: '11px', fontWeight: 600 }}>
            {batchError}
          </div>
        )}
      </section>

      {/* 1. Measured Monetary Recovery Outcomes */}
      <section className="analytics-section">
        <span className="eyebrow">Measured Financial Outcome & Recovery Value</span>
        <div className="metric-grid" aria-label="Monetary recovery metrics">
          {monetaryCards.map((item) => (
            <MetricCard key={item.label} {...item} />
          ))}
        </div>
      </section>

      {/* 2. Recovery Performance by Action */}
      <section className="analytics-section" style={{ marginTop: '24px' }}>
        <span className="eyebrow">Recovery Performance by Action</span>
        <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: '9px', padding: '18px 22px', marginTop: '8px', overflowX: 'auto' }}>
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Recovery Action</th>
                <th>Attempted</th>
                <th>Successful</th>
                <th>Failed / Stopped</th>
                <th>Revenue at Risk</th>
                <th>Revenue Recovered</th>
                <th>Monetary Recovery Rate</th>
                <th>Action Resolution Rate</th>
              </tr>
            </thead>
            <tbody>
              {['RETRY', 'ALTERNATE_METHOD', 'CUSTOMER_ACTION', 'ESCALATE'].map((action) => {
                const act = monetary?.byAction?.[action];
                return (
                  <tr key={action}>
                    <td><strong>{action}</strong></td>
                    <td>{act?.attemptedCount ?? 0}</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{act?.successfulCount ?? 0}</td>
                    <td style={{ color: ((act?.failedCount || 0) + (act?.stoppedCount || 0)) > 0 ? 'var(--amber)' : 'inherit' }}>
                      {(act?.failedCount ?? 0) + (act?.stoppedCount ?? 0)}
                    </td>
                    <td>{formatMoney(act?.revenueAtRisk, monetary?.currency)}</td>
                    <td style={{ fontWeight: 600, color: 'var(--green)' }}>{formatMoney(act?.revenueRecovered, monetary?.currency)}</td>
                    <td style={{ fontWeight: 600 }}>{formatRate(act?.monetaryRecoveryRate)}</td>
                    <td>{formatRate(act?.transactionRecoveryRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Operational Outcomes */}
      <section className="analytics-section" style={{ marginTop: '24px' }}>
        <span className="eyebrow">Durable Operational Outcomes</span>
        <div className="metric-grid" aria-label="Operational recovery metrics">
          {operationalCards.map((item) => (
            <MetricCard key={item.label} {...item} />
          ))}
        </div>
      </section>

      {/* 4. Decision Analytics */}
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
          <span className="panel-kicker">Autonomous Revenue Recovery Loop</span>
          <h2>Batch-Level Monetary Recovery & Intelligence Cockpit</h2>
          <p>
            Operational payment outcomes are captured reliably via PostgreSQL. ML predictions and calibration are computed
            from runtime feedback buffers without altering database schema.
            Failed payment batch → ML recovery intelligence & policy rules → Automated execution & retries → Measured monetary outcome.
          </p>
        </div>
        <span className="panel-status">Phase 2 / 6.11</span>
        <span className="panel-status">Recoverly Complete</span>
      </section>
    </div>
  );
}
