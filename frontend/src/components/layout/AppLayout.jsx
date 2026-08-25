const navigation = [
  { id: 'overview', label: 'Overview', icon: 'O' },
  { id: 'transactions', label: 'Transactions', icon: 'T' },
  { id: 'recovery', label: 'Recovery queue', icon: 'R' },
];

export function AppLayout({ activeView, onNavigate, children }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="Recoverly home">
          <span className="brand-symbol">+</span>
          <span>recoverly</span>
        </div>

        <div className="workspace-switcher">
          <span className="workspace-avatar">AC</span>
          <span className="workspace-copy"><strong>Acme Corp</strong><small>Payments workspace</small></span>
          <span className="chevron">v</span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          {navigation.map((item) => (
            <button className={`nav-item ${activeView === item.id ? 'is-active' : ''}`} key={item.id} onClick={() => onNavigate(item.id)} type="button">
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
              {item.id === 'recovery' && <span className="nav-count">8</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item" type="button"><span className="nav-icon" aria-hidden="true">?</span>Help center</button>
          <div className="user-row"><span className="user-avatar">AK</span><span className="workspace-copy"><strong>Alex Kim</strong><small>Administrator</small></span><span className="more">...</span></div>
        </div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  );
}
