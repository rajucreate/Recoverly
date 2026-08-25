import { MetricCard } from '../components/ui/MetricCard.jsx';

const activity = [
  { label: 'Payments monitored', value: '12,480', change: '+12.8%', tone: 'positive' },
  { label: 'Success rate', value: '96.4%', change: '+1.6%', tone: 'positive' },
  { label: 'Needs attention', value: '8', change: '3 urgent', tone: 'warning' },
];

export function DashboardPage({ activeView, onNavigate }) {
  const title = activeView === 'overview' ? 'Good morning, Alex' : activeView === 'transactions' ? 'Transactions' : 'Recovery queue';

  return (
    <div className="page-wrap">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{activeView === 'overview' ? 'Overview' : title}</strong></div><div className="topbar-actions"><span className="live-indicator"><span /> Systems operational</span><button className="icon-button" type="button" aria-label="Notifications">!</button><span className="topbar-avatar">AK</span></div></header>
      <section className="page-intro"><div><p className="eyebrow">Monday, August 24, 2026</p><h1>{title}</h1><p className="intro-copy">Here is the pulse of your payment operations.</p></div>{activeView === 'overview' ? <button className="primary-button" type="button" onClick={() => onNavigate('create')}>Create transaction <span>+</span></button> : <button className="date-button" type="button">Last 30 days <span>v</span></button>}</section>
      <section className="metric-grid" aria-label="Payment overview metrics">{activity.map((item) => <MetricCard key={item.label} {...item} detail={item.change} />)}</section>
      <section className="foundation-panel"><div className="panel-accent" /><div><span className="panel-kicker">Foundation ready</span><h2>Your operations cockpit is taking shape.</h2><p>The dashboard shell is connected to the API layer and ready for the next phase of transaction workflows.</p></div><span className="panel-status">Phase 1 / 5.1</span></section>
      <section className="lower-grid"><div className="activity-panel"><div className="panel-header"><div><span className="eyebrow">Live feed</span><h2>Recent activity</h2></div><button className="text-button" type="button">View all <span>-&gt;</span></button></div><div className="empty-state"><span className="empty-icon">~</span><strong>No activity to display yet</strong><span>Payment events will appear here as your workspace goes live.</span></div></div><aside className="brief-panel"><span className="eyebrow">Next up</span><h2>Recovery intelligence</h2><p>Once transactions are flowing, your recovery queue will surface the actions most likely to bring payments back.</p><span className="progress-line"><span /></span><small>Foundation complete <strong>1 / 4</strong></small></aside></section>
    </div>
  );
}
