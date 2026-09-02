const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let details = null;
    try {
      const payload = await response.json();
      const apiError = payload.error && typeof payload.error === 'object' ? payload.error : payload;
      message = apiError.message || payload.message || message;
      details = apiError.details || payload.details || null;
    } catch {
      // The status message is the useful fallback for non-JSON responses.
    }
    throw new ApiError(message, response.status, details);
  }

  return response.status === 204 ? null : response.json();
}

export function getTransaction(transactionId) {
  return request(`/transactions/${encodeURIComponent(transactionId)}`);
}

export function createTransaction(data) {
  return request('/transactions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function createPaymentAttempt(transactionId, data) {
  return request(`/transactions/${encodeURIComponent(transactionId)}/attempts`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function executeRecovery(transactionId, data) {
  return request(`/transactions/${encodeURIComponent(transactionId)}/recovery/execute`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getRecoveryAnalytics() {
  return request('/analytics/recovery');
}
