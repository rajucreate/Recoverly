export function MetricCard({ label, value, detail, tone = 'neutral' }) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-heading"><span>{label}</span><span className="metric-dot" /></div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
    </article>
  );
}
