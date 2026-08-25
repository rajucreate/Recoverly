import { useState } from 'react';
import { AppLayout } from './components/layout/AppLayout.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { CreateTransactionPage } from './pages/CreateTransactionPage.jsx';
import { TransactionDetailPage } from './pages/TransactionDetailPage.jsx';

export default function App() {
  const [activeView, setActiveView] = useState('overview');
  const [createdTransaction, setCreatedTransaction] = useState(null);

  function handleCreated(transaction, openDetail = false) {
    setCreatedTransaction(transaction);
    if (openDetail) setActiveView('transaction-detail');
  }

  function renderView() {
    if (activeView === 'create') return <CreateTransactionPage onCreated={handleCreated} onCancel={() => setActiveView('overview')} />;
    if (activeView === 'transaction-detail' && createdTransaction) return <TransactionDetailPage transaction={createdTransaction} onBack={() => setActiveView('transactions')} onTransactionUpdated={setCreatedTransaction} />;
    return <DashboardPage activeView={activeView} onNavigate={setActiveView} />;
  }

  return (
    <AppLayout activeView={activeView} onNavigate={setActiveView}>
      {renderView()}
    </AppLayout>
  );
}
