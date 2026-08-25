import { useState } from 'react';
import { createTransaction } from '../../services/api/client.js';

const initialValues = { amount: '', currency: 'INR', customerId: '' };

function validate(values) {
  const errors = {};
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(values.amount) || Number(values.amount) <= 0) {
    errors.amount = 'Enter a positive amount, for example 5000 or 5000.50.';
  }
  if (!/^[A-Z]{3}$/.test(values.currency.trim().toUpperCase())) {
    errors.currency = 'Use a three-letter currency code, such as INR.';
  }
  if (!values.customerId.trim()) errors.customerId = 'Customer ID is required.';
  return errors;
}

function getApiErrorMessage(error) {
  if (error?.details && typeof error.details === 'object') return `${error.message || 'Request failed'}: ${Object.values(error.details).join(' ')}`;
  return error?.message || 'Unable to create the transaction. Please try again.';
}

export function CreateTransactionForm({ onCreated, onCancel }) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [state, setState] = useState({ status: 'idle', error: null, transaction: null });

  function handleChange(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: name === 'currency' ? value.toUpperCase() : value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
    if (state.status !== 'idle') setState({ status: 'idle', error: null, transaction: null });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setState({ status: 'loading', error: null, transaction: null });
    try {
      const response = await createTransaction({
        amount: Number(values.amount),
        currency: values.currency.trim().toUpperCase(),
        customerId: values.customerId.trim(),
      });
      const transaction = response.data;
      setState({ status: 'success', error: null, transaction });
      onCreated(transaction);
    } catch (error) {
      setState({ status: 'error', error: getApiErrorMessage(error), transaction: null });
    }
  }

  if (state.status === 'success') {
    return (
      <div className="transaction-success" role="status">
        <div className="success-check">+</div>
        <span className="panel-kicker success-kicker">Transaction created</span>
        <h2>Ready for the next step.</h2>
        <p>Your transaction has been created with a pending status.</p>
        <div className="success-summary">
          <SummaryRow label="Transaction ID" value={state.transaction.id} copyable />
          <SummaryRow label="Amount" value={`${state.transaction.currency} ${state.transaction.amount}`} />
          <SummaryRow label="Customer ID" value={state.transaction.customerId} />
          <SummaryRow label="Status" value={state.transaction.status} />
          <SummaryRow label="Created" value={formatDate(state.transaction.createdAt)} />
        </div>
        <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setState({ status: 'idle', error: null, transaction: null })}>Create another</button><button className="primary-button" type="button" onClick={() => onCreated(state.transaction, true)}>Open transaction <span>-&gt;</span></button></div>
      </div>
    );
  }

  return (
    <form className="transaction-form" onSubmit={handleSubmit} noValidate>
      <div className="form-header"><div><span className="panel-kicker">New transaction</span><h2>Set up a payment to monitor.</h2><p>Start with the core details. You can add payment attempts later.</p></div><span className="required-note">* Required</span></div>
      {state.status === 'error' && <div className="form-alert" role="alert"><strong>Could not create transaction</strong><span>{state.error}</span></div>}
      <div className="form-fields">
        <Field label="Amount" name="amount" value={values.amount} onChange={handleChange} error={errors.amount} placeholder="5000.00" inputMode="decimal" prefix="INR" />
        <Field label="Currency" name="currency" value={values.currency} onChange={handleChange} error={errors.currency} placeholder="INR" maxLength={3} />
        <Field label="Customer ID" name="customerId" value={values.customerId} onChange={handleChange} error={errors.customerId} placeholder="customer-001" />
      </div>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit" disabled={state.status === 'loading'}>{state.status === 'loading' ? 'Creating...' : 'Create transaction'} <span>-&gt;</span></button></div>
    </form>
  );
}

function Field({ label, name, value, onChange, error, prefix, ...props }) {
  return <label className="field"><span>{label} <em>*</em></span><div className={`input-wrap ${error ? 'has-error' : ''}`}>{prefix && <small>{prefix}</small>}<input name={name} value={value} onChange={onChange} aria-invalid={Boolean(error)} aria-describedby={error ? `${name}-error` : undefined} {...props} /></div>{error && <small className="field-error" id={`${name}-error`}>{error}</small>}</label>;
}

function SummaryRow({ label, value, copyable }) { return <div className="summary-row"><span>{label}</span><strong className={copyable ? 'summary-id' : ''}>{value}</strong></div>; }
function formatDate(value) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unavailable'; }
