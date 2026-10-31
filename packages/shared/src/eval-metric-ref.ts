/**
 * Return registry glossary keys that may describe a verdict metric reference.
 *
 * Verdicts contain several historical shapes: `metric:key`, inline `key=value`,
 * component paths, and A2A OTel/Prometheus aliases. Keeping this projection in
 * shared code lets API coverage guards and both Hub surfaces resolve the same
 * references instead of drifting.
 */
export function metricRefKeyCandidates(ref: string): string[] {
  const withoutMetricPrefix = ref.replace(/^metric:/, '');
  const ratioExpression = stripMetricRefValue(withoutMetricPrefix);
  if (ratioExpression.startsWith('ratio:') && ratioExpression.includes('/')) {
    return [...new Set([ratioExpression, ratioExpression.toLowerCase()])];
  }

  const withoutPrefix = stripMetricRefValue(withoutMetricPrefix.replace(/^ratio:/, ''));
  const afterSlash = withoutPrefix.includes('/')
    ? withoutPrefix.slice(withoutPrefix.lastIndexOf('/') + 1)
    : withoutPrefix;
  return [
    ...new Set(
      [
        afterSlash,
        afterSlash.toLowerCase(),
        withoutPrefix,
        withoutPrefix.toLowerCase(),
        ...a2aMetricKeyCandidates(afterSlash),
        ...a2aMetricKeyCandidates(withoutPrefix),
        ...colonPathCandidates(afterSlash),
      ].filter(Boolean),
    ),
  ];
}

function stripMetricRefValue(ref: string): string {
  return ref.replace(/=(?=[^{}]*$).*/, '').replace(/\{.*$/, '');
}

function a2aMetricKeyCandidates(metric: string): string[] {
  const candidates: string[] = [];
  if (metric.startsWith('cat_cafe.a2a.')) {
    const dotted = metric.slice('cat_cafe.a2a.'.length);
    candidates.push(...withCounterTotalVariant(dotted));
    candidates.push(...a2aSuffixCandidates(dotted));
  }
  if (metric.startsWith('cat_cafe_a2a_')) {
    candidates.push(...a2aSuffixCandidates(metric.slice('cat_cafe_a2a_'.length)));
  }
  return candidates;
}

const A2A_PROMETHEUS_PREFIXES = [
  ['inline_action_', 'inline_action.'],
  ['grounding_', 'grounding.'],
  ['hold_', 'hold_lifecycle.'],
  ['c1_', 'c1.'],
  ['c2_', 'c2.'],
] as const;

function a2aSuffixCandidates(suffix: string): string[] {
  const mapping = A2A_PROMETHEUS_PREFIXES.find(([prefix]) => suffix.startsWith(prefix));
  return mapping ? withCounterTotalVariant(`${mapping[1]}${suffix.slice(mapping[0].length)}`) : [];
}

function withCounterTotalVariant(key: string): string[] {
  return key.endsWith('_total') ? [key, key.slice(0, -'_total'.length)] : [key];
}

const HEX_SHA_RE = /^[0-9a-f]{7,12}$/;

/**
 * For colon-separated provenance metric paths (e.g. `process:runtime_pid`,
 * `commit:ce5199d88:terminal_release_warmup`), generate glossary-compatible
 * candidates by replacing colons with dots (glossary keys can't contain `:`).
 * Also strips hex-SHA segments from ≥3-segment paths so dynamic commit
 * references resolve to a stable glossary key.
 */
function colonPathCandidates(key: string): string[] {
  if (!key.includes(':')) return [];
  const candidates: string[] = [];

  // Replace colons with dots to match glossary key schema [a-z0-9._-]
  const dotted = key.replace(/:/g, '.');
  candidates.push(dotted, dotted.toLowerCase());

  // Strip hex SHA-like segments (7-12 hex chars) from multi-segment paths
  const parts = key.split(':');
  if (parts.length >= 3) {
    const filtered = parts.filter((p) => !HEX_SHA_RE.test(p));
    if (filtered.length < parts.length) {
      const stripped = filtered.join('.');
      candidates.push(stripped, stripped.toLowerCase());
    }
  }

  return candidates;
}
