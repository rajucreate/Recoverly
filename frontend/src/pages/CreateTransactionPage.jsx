import { CreateTransactionForm } from '../components/transactions/CreateTransactionForm.jsx';

export function CreateTransactionPage({ onCreated, onCancel }) {
  return <div className="page-wrap"><header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>Create transaction</strong></div></header><section className="page-intro compact-intro"><div><p className="eyebrow">Transactions / New</p><h1>Create a transaction</h1><p className="intro-copy">Capture a payment before it enters the recovery workflow.</p></div></section><CreateTransactionForm onCreated={onCreated} onCancel={onCancel} /></div>;
}
