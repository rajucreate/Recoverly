export function createProviderRequestAdapter(providerId) {
  if (providerId === 'simulator') {
    return ({ providerOutcome, ...request }) => ({
      ...request,
      providerRequest: { testDirective: providerOutcome }
    });
  }

  return ({ providerOutcome: _providerOutcome, ...request }) => request;
}