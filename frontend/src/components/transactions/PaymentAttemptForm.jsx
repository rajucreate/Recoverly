import { useState } from 'react';
import { createPaymentAttempt, getTransaction } from '../../services/api/client.js';

const initialValues = { paymentMethod: 'UPI', outcome: 'SUCCESS', failureCategory: 'TEMPORARY_FAILURE', failureReason: '' };
const failureCategories = [
  ['TEMPORARY_FAILURE', 'Temporary failure'],
  ['PAYMENT_METHOD_FAILURE', 'Payment method failure'],
  ['CUSTOMER_ACTION_REQUIRED', 'Customer action required'],
  ['UNKNOWN_FAILURE', 'Unknown failure'],
];

function validate(values) {
  const errors = {};
  if (!['UPI', 'CARD', 'NET_BANKING'].includes(values.paymentMethod)) errors.paymentMethod = 'Select a valid payment method.';
  if (!['SUCCESS', 'FAILED'].includes(values.outcome)) errors.outcome = 'Select a valid outcome.';
  if (values.outcome === 'FAILED') {
    if (!failureCategories.some(([value]) => value === values.failureCategory)) errors.failureCategory = 'Select a failure category.';
    if (!values.failureReason.trim()) errors.failureReason = 'Failure reason is required.';
  }
  return errors;
}

function apiErrorMessage(error) {
  if (error?.details && typeof error.details === 'object') return `${error.message || 'Request failed'}: ${Object.values(error.details).join(' ')}`;
  return error?.message || 'Unable to create the payment attempt. Please try again.';
}

export function PaymentAttemptForm({ transaction, onTransactionUpdated }) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [state, setState] = useState({ status: 'idle', error: null, result: null });

  function handleChange(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
    if (state.status !== 'idle') setState({ status: 'idle', error: null, result: null });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setState({ status: 'loading', error: null, result: null });
    try {
      const response = await createPaymentAttempt(transaction.id, {
        paymentMethod: values.paymentMethod,
        outcome: values.outcome,
        ...(values.outcome === 'FAILED' ? { failureCategory: values.failureCategory, failureReason: values.failureReason.trim() } : {}),
      });
      const refreshedTransaction = await getTransaction(transaction.id);
      setState({ status: 'success', error: null, result: response.data });
      onTransactionUpdated(refreshedTransaction.data, response.data);
    } catch (error) {
      setState({ status: 'error', error: apiErrorMessage(error), result: null });
    }
  }

  if (state.status === 'success') {
    const { attempt, recoveryAction } = state.result;
    return <section className="attempt-result" role="status"><div className="attempt-result-heading"><div><span className="panel-kicker success-kicker">Attempt recorded</span><h2>{attempt.outcome === 'SUCCESS' ? 'Payment succeeded.' : 'Payment failed.'}</h2></div><span className={`status-badge ${attempt.outcome === 'FAILED' ? 'failure-badge' : ''}`}>{attempt.status}</span></div><div className="attempt-summary"><SummaryRow label="Attempt number" value={`#${attempt.attemptNumber}`} /><SummaryRow label="Payment method" value={attempt.paymentMethod} /><SummaryRow label="Outcome" value={attempt.outcome} />{attempt.failureCategory && <SummaryRow label="Failure category" value={attempt.failureCategory} />}{attempt.failureReason && <SummaryRow label="Failure reason" value={attempt.failureReason} />}</div><div className="recommendation-box"><span className="eyebrow">Recovery recommendation</span><strong>{recoveryAction ? recoveryAction.actionType : 'None'}</strong><span>{recoveryAction ? recoveryAction.reason : 'No recovery action is needed for a successful attempt.'}</span></div><button className="secondary-button" type="button" onClick={() => setState({ status: 'idle', error: null, result: null })}>Simulate another attempt</button></section>;
  }

  const terminal = transaction.status === 'SUCCESS' || transaction.status === 'RECOVERED';
  return <form className="attempt-form" onSubmit={handleSubmit} noValidate><div className="form-header"><div><span className="panel-kicker">Payment simulation</span><h2>Simulate Payment Attempt</h2><p>Record a provider outcome against this transaction.</p></div><span className="required-note">* Required</span></div>{state.status === 'error' && <div className="form-alert" role="alert"><strong>Could not record attempt</strong><span>{state.error}</span></div>}{terminal && <div className="form-alert terminal-alert" role="status"><strong>Transaction is complete</strong><span>No further payment attempts can be added.</span></div>}<div className="attempt-options"><ChoiceGroup label="Payment method" name="paymentMethod" value={values.paymentMethod} options={[['UPI', 'UPI'], ['CARD', 'Card'], ['NET_BANKING', 'Net banking']]} onChange={handleChange} error={errors.paymentMethod} /><ChoiceGroup label="Outcome" name="outcome" value={values.outcome} options={[['SUCCESS', 'Success'], ['FAILED', 'Failed']]} onChange={handleChange} error={errors.outcome} /></div>{values.outcome === 'FAILED' && <div className="failure-fields"><label className="field"><span>Failure category <em>*</em></span><div className={`input-wrap ${errors.failureCategory ? 'has-error' : ''}`}><select name="failureCategory" value={values.failureCategory} onChange={handleChange}><option value="">Select a category</option>{failureCategories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>{errors.failureCategory && <small className="field-error">{errors.failureCategory}</small>}</label><label className="field"><span>Failure reason <em>*</em></span><textarea name="failureReason" value={values.failureReason} onChange={handleChange} placeholder="Bank server temporarily unavailable" rows="3" aria-invalid={Boolean(errors.failureReason)} />{errors.failureReason && <small className="field-error">{errors.failureReason}</small>}</label></div>}<div className="form-actions"><button className="primary-button" type="submit" disabled={state.status === 'loading' || terminal}>{state.status === 'loading' ? 'Recording...' : 'Record attempt'} <span>-&gt;</span></button></div></form>;
}

function ChoiceGroup({ label, name, value, options, onChange, error }) { return <fieldset className="choice-group"><legend>{label} <em>*</em></legend><div className="choice-options">{options.map(([optionValue, optionLabel]) => <label className={`choice ${value === optionValue ? 'is-selected' : ''}`} key={optionValue}><input type="radio" name={name} value={optionValue} checked={value === optionValue} onChange={onChange} />{optionLabel}</label>)}</div>{error && <small className="field-error">{error}</small>}</fieldset>; }
function SummaryRow({ label, value }) { return <div className="summary-row"><span>{label}</span><strong>{value}</strong></div>; }
