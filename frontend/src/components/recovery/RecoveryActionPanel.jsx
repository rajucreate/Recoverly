import { useState } from 'react';
import { executeRecovery, getTransaction } from '../../services/api/client.js';

const paymentMethods = [
  ['UPI', 'UPI'],
  ['CARD', 'Card'],
  ['NET_BANKING', 'Net banking'],
];

const actionCopy = {
  RETRY: { title: 'Execute Retry', description: 'Retry the payment using the original payment method automatically.' },
  ALTERNATE_METHOD: { title: 'Execute Alternate Method', description: 'Try a different payment method after the original method failed.' },
  CUSTOMER_ACTION: { title: 'Customer action required', description: 'The customer must complete an action before another payment attempt can succeed.' },
  ESCALATE: { title: 'Escalate transaction', description: 'This payment should be reviewed by your operations team.' },
};

export function RecoveryActionPanel({ transaction, onTransactionUpdated }) {
  const actions = [...(transaction.recoveryActions || [])].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const action = actions[0];
  const failedAttempt = action ? transaction.paymentAttempts?.find((attempt) => attempt.id === action.attemptId) : null;
  const [paymentMethod, setPaymentMethod] = useState('');
  const [providerOutcome, setProviderOutcome] = useState('SUCCESS');
  const [state, setState] = useState({ status: 'idle', error: null, result: null });

  if (!action) return null;
  const copy = actionCopy[action.actionType] || { title: action.actionType, description: action.reason };
  const canExecute = action.status === 'RECOMMENDED';
  const isAttemptAction = action.actionType === 'RETRY' || action.actionType === 'ALTERNATE_METHOD';

  async function handleExecute(event) {
    event.preventDefault();
    if (!canExecute) return;
    if (action.actionType === 'ALTERNATE_METHOD' && (!paymentMethod || paymentMethod === failedAttempt?.paymentMethod)) return;

    setState({ status: 'loading', error: null, result: null });
    try {
      const response = await executeRecovery(transaction.id, {
        recoveryActionId: action.id,
        ...(action.actionType === 'ALTERNATE_METHOD' ? { paymentMethod } : {}),
        ...(isAttemptAction ? { providerOutcome } : {}),
      });
      const refreshedTransaction = await getTransaction(transaction.id);
      setState({ status: 'success', error: null, result: response.data });
      onTransactionUpdated(refreshedTransaction.data);
    } catch (error) {
      setState({ status: 'error', error: formatError(error), result: null });
    }
  }

  const displayedStatus = state.status === 'success' ? state.result.recoveryAction.status : action.status;
  return <section className="recovery-panel"><div className="recovery-heading"><div><span className="panel-kicker recovery-kicker">Recovery recommendation</span><h2>{copy.title}</h2></div><span className={`action-status action-${displayedStatus.toLowerCase()}`}>{displayedStatus}</span></div><p className="recovery-reason">{action.reason}</p>{state.status === 'error' && <div className="form-alert" role="alert"><strong>Could not execute recovery</strong><span>{state.error}</span></div>}{state.status === 'success' && <div className="execution-result" role="status"><strong>Recovery execution completed</strong><span>{state.result.attempt ? `Attempt #${state.result.attempt.attemptNumber} recorded with ${state.result.attempt.outcome}.` : 'No payment attempt was created for this action.'}</span></div>}{canExecute && <form onSubmit={handleExecute}><div className="recovery-controls">{isAttemptAction && <label className="field"><span>Provider outcome <em>*</em></span><div className="input-wrap"><select value={providerOutcome} onChange={(event) => setProviderOutcome(event.target.value)}><option value="SUCCESS">Success</option><option value="FAILED">Failed</option></select></div></label>}{action.actionType === 'RETRY' && <div className="recovery-note"><span>Original method</span><strong>{failedAttempt?.paymentMethod || 'Automatic'}</strong></div>}{action.actionType === 'ALTERNATE_METHOD' && <label className="field"><span>Alternate payment method <em>*</em></span><div className="input-wrap"><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="">Select a different method</option>{paymentMethods.filter(([value]) => value !== failedAttempt?.paymentMethod).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div></label>}</div><button className="primary-button" type="submit" disabled={state.status === 'loading' || (action.actionType === 'ALTERNATE_METHOD' && (!paymentMethod || paymentMethod === failedAttempt?.paymentMethod))}>{state.status === 'loading' ? 'Executing...' : `Execute ${action.actionType === 'RETRY' ? 'retry' : action.actionType === 'ALTERNATE_METHOD' ? 'alternate method' : 'action'}`} <span>-&gt;</span></button></form>}{!canExecute && state.status !== 'success' && <p className="executed-note">This recovery action is no longer available for execution.</p>}</section>;
}

function formatError(error) {
  if (error?.details && typeof error.details === 'object') return `${error.message || 'Request failed'}: ${Object.values(error.details).join(' ')}`;
  return error?.message || 'Unable to execute recovery. Please try again.';
}
