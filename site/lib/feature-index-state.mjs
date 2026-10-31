/**
 * Select the feature-index view for its current lifecycle state.
 *
 * Keeping lifecycle state separate from the feature array prevents an empty
 * array from being mistaken for a completed request with no matching results.
 */
export function selectFeatureIndexView(state, features, query, status) {
  if (state === 'loading') {
    return { kind: 'message', key: 'docs.loading.features' };
  }
  if (state === 'error') {
    return { kind: 'message', key: 'docs.error.features' };
  }
  if (state !== 'ready') {
    throw new TypeError(`Unknown feature index state: ${String(state)}`);
  }

  const q = query.toLowerCase();
  const filtered = features.filter((feature) => {
    const matchesStatus = status === 'all' || feature.normalizedStatus === status;
    const matchesQuery = !q || feature.id.toLowerCase().includes(q) || feature.name.toLowerCase().includes(q);
    return matchesStatus && matchesQuery;
  });

  return { kind: 'features', features: filtered };
}
