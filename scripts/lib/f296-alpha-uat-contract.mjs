import { createHash } from 'node:crypto';
import {
  CONTEXT_PROJECTION_ENUMS,
  CONTEXT_PROJECTION_TELEMETRY_CONTRACT,
} from '../../packages/api/dist/domains/cats/services/session/context-projection-telemetry-contract.js';

export const ALPHA_API_ORIGIN = 'http://127.0.0.1:3012';
export const ALPHA_REDIS_PORT = 6398;
export const JOURNEYS = Object.freeze([
  'cold',
  'resumed-small',
  'resumed-large',
  'replacement',
  'authoritative-compaction',
]);

const CONTRACT_SHA256 = 'e6bbc69ddd6104cbeb6f26a3bfd7c7a38cdbee456c954379fd3883f7016046b7';
const OUTCOMES = new Set(['passed', 'unsupported', 'failed']);
const REASONS = new Set([
  'observed',
  'wrong_api_origin',
  'wrong_redis_endpoint',
  'wrong_revision',
  'alpha_not_ready',
  'canary_not_found',
  'canary_not_app_server',
  'api_unavailable',
  'invocation_rejected',
  'thread_creation_failed',
  'invocation_failed',
  'invocation_timeout',
  'telemetry_unavailable',
  'telemetry_signal_missing',
  'metric_signal_missing',
  'continuity_mismatch',
  'prerequisite_not_observed',
  'provider_replacement_trigger_unavailable',
  'provider_compaction_trigger_unavailable',
  'contract_drift',
  'evidence_privacy_violation',
  'invalid_options',
]);

export class UatError extends Error {
  constructor(outcome, reason) {
    super(reason);
    this.outcome = outcome;
    this.reason = reason;
  }
}

export function validateCanonicalContract(
  contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT,
  enums = CONTEXT_PROJECTION_ENUMS,
) {
  const digest = createHash('sha256').update(JSON.stringify({ contract, enums })).digest('hex');
  if (contract.schemaVersion !== 1 || digest !== CONTRACT_SHA256) throw new UatError('failed', 'contract_drift');
}

export function validateAlphaCoordinates(apiUrl, redisUrl) {
  let api;
  try {
    api = new URL(apiUrl);
  } catch {
    throw new UatError('failed', 'wrong_api_origin');
  }
  if (api.origin !== ALPHA_API_ORIGIN || api.href !== `${ALPHA_API_ORIGIN}/`) {
    throw new UatError('failed', 'wrong_api_origin');
  }
  let redis;
  try {
    redis = new URL(redisUrl);
  } catch {
    throw new UatError('failed', 'wrong_redis_endpoint');
  }
  if (
    redis.protocol !== 'redis:' ||
    !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
    Number(redis.port) !== ALPHA_REDIS_PORT ||
    redis.username !== '' ||
    redis.password !== '' ||
    !['', '/'].includes(redis.pathname) ||
    redis.search !== '' ||
    redis.hash !== ''
  ) {
    throw new UatError('failed', 'wrong_redis_endpoint');
  }
}

export function assertAlphaSnapshot({ expectedRevision, health, readiness, cats, catId }) {
  if (health?.deploymentRevision !== expectedRevision) throw new UatError('failed', 'wrong_revision');
  if (readiness?.status !== 'ready') throw new UatError('failed', 'alpha_not_ready');
  const canary = cats?.cats?.find((cat) => cat?.id === catId);
  if (!canary || canary.clientId !== 'openai') throw new UatError('failed', 'canary_not_found');
  if (canary.codexCarrier?.effective !== 'app_server') throw new UatError('failed', 'canary_not_app_server');
}

export function boundEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unrecognized';
}

export function unsupportedJourney(journey, reason, observation = null) {
  return { journey, outcome: 'unsupported', reason, observation };
}

function promName(value) {
  return value.replaceAll('.', '_').replaceAll('-', '_');
}

function parsePrometheus(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$/.exec(line.trim());
    if (!match) continue;
    const labels = {};
    for (const item of match[2]?.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"])*)"/g) ?? []) {
      labels[item[1]] = item[2];
    }
    rows.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return rows;
}

function metricValue(rows, name, labels = {}) {
  return rows
    .filter((row) => row.name === name && Object.entries(labels).every(([key, value]) => row.labels[key] === value))
    .reduce((sum, row) => sum + row.value, 0);
}

function metricIncreased(before, after, name, labels) {
  return metricValue(after, name, labels) > metricValue(before, name, labels);
}

const tierTraceFields = [
  ['tierT0Count', 'tierT0Bytes'],
  ['tierT1Count', 'tierT1Bytes'],
  ['tierT2Count', 'tierT2Bytes'],
  ['tierInvalidCount', 'tierInvalidBytes'],
  ['tierUnrecognizedCount', 'tierUnrecognizedBytes'],
];

export function projectTraceEvidence(span) {
  const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
  const enums = CONTEXT_PROJECTION_ENUMS;
  const attributes = span?.attributes;
  if (!attributes || attributes[contract.traceAttributes.mode] === undefined) return null;
  const tiers = [...enums.sourceTiers, 'unrecognized'].map((tier, index) => {
    const [countField, bytesField] = tierTraceFields[index];
    return {
      tier,
      count: attributes[contract.traceAttributes[countField]],
      bytes: attributes[contract.traceAttributes[bytesField]],
    };
  });
  const numeric = [
    ...tiers.flatMap((tier) => [tier.count, tier.bytes]),
    attributes[contract.traceAttributes.deliveryLatencyMs],
  ];
  if (numeric.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return {
    internal: {
      provider: boundEnum(attributes[contract.traceAttributes.provider], enums.providers),
      carrier: boundEnum(attributes[contract.traceAttributes.carrier], enums.carriers),
      disposition: boundEnum(attributes[contract.traceAttributes.disposition], enums.dispositions),
    },
    evidence: {
      mode: boundEnum(attributes[contract.traceAttributes.mode], enums.contextModes),
      reason: boundEnum(attributes[contract.traceAttributes.reason], enums.reasons),
      transition: boundEnum(attributes[contract.traceAttributes.transition], enums.transitions),
      delta: boundEnum(attributes[contract.traceAttributes.deltaSize], enums.deltaSizes),
      tiers,
      latencyMs: attributes[contract.traceAttributes.deliveryLatencyMs],
      ledgerTerminal: boundEnum(attributes[contract.traceAttributes.ledgerOutcome], enums.ledgerOutcomes),
      traceRefs: [{ traceId: span.traceId, spanId: span.spanId }],
    },
  };
}

export function metricsProveObservation(beforeText, afterText, projection) {
  const before = parsePrometheus(beforeText);
  const after = parsePrometheus(afterText);
  const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
  const attrs = contract.metricAttributes;
  const labels = {
    [promName(attrs.disposition)]: projection.internal.disposition,
    [promName(attrs.reason)]: projection.evidence.reason,
    [promName(attrs.transition)]: projection.evidence.transition,
    [promName(attrs.mode)]: projection.evidence.mode,
    [promName(attrs.deltaSize)]: projection.evidence.delta,
  };
  if (!metricIncreased(before, after, promName(contract.metricNames.transitionTotal), labels)) return false;
  if (!metricIncreased(before, after, `${promName(contract.metricNames.deliveryLatency)}_count`, {})) return false;
  if (
    !metricIncreased(before, after, promName(contract.metricNames.ledgerOutcomeTotal), {
      [promName(attrs.ledgerOutcome)]: projection.evidence.ledgerTerminal,
    })
  ) {
    return false;
  }
  return projection.evidence.tiers.every(({ tier }) => {
    const tierLabels = { [promName(attrs.tier)]: tier };
    return (
      metricIncreased(before, after, `${promName(contract.metricNames.tierCount)}_count`, tierLabels) &&
      metricIncreased(before, after, `${promName(contract.metricNames.tierBytes)}_count`, tierLabels)
    );
  });
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(value, key));
}

export function assertContentFreeManifest(manifest) {
  const enums = CONTEXT_PROJECTION_ENUMS;
  const bounded = (value, values) => typeof value === 'string' && (values.includes(value) || value === 'unrecognized');
  const expectedTiers = [...enums.sourceTiers, 'unrecognized'];
  const valid =
    exactKeys(manifest, ['schemaVersion', 'revision', 'journeys']) &&
    manifest.schemaVersion === 1 &&
    /^[0-9a-f]{40}$/.test(manifest.revision) &&
    Array.isArray(manifest.journeys) &&
    manifest.journeys.length === JOURNEYS.length &&
    manifest.journeys.every((item, index) => {
      if (!exactKeys(item, ['journey', 'outcome', 'reason', 'observation'])) return false;
      if (item.journey !== JOURNEYS[index] || !OUTCOMES.has(item.outcome) || !REASONS.has(item.reason)) return false;
      if (item.observation === null) return item.outcome !== 'passed';
      const observation = item.observation;
      return (
        exactKeys(observation, [
          'mode',
          'reason',
          'transition',
          'delta',
          'tiers',
          'latencyMs',
          'ledgerTerminal',
          'traceRefs',
        ]) &&
        bounded(observation.mode, enums.contextModes) &&
        bounded(observation.reason, enums.reasons) &&
        bounded(observation.transition, enums.transitions) &&
        bounded(observation.delta, enums.deltaSizes) &&
        bounded(observation.ledgerTerminal, enums.ledgerOutcomes) &&
        Number.isSafeInteger(observation.latencyMs) &&
        observation.latencyMs >= 0 &&
        Array.isArray(observation.tiers) &&
        observation.tiers.length === expectedTiers.length &&
        observation.tiers.every(
          (tier, tierIndex) =>
            exactKeys(tier, ['tier', 'count', 'bytes']) &&
            tier.tier === expectedTiers[tierIndex] &&
            Number.isSafeInteger(tier.count) &&
            tier.count >= 0 &&
            Number.isSafeInteger(tier.bytes) &&
            tier.bytes >= 0,
        ) &&
        Array.isArray(observation.traceRefs) &&
        observation.traceRefs.length === 1 &&
        observation.traceRefs.every(
          (ref) =>
            exactKeys(ref, ['traceId', 'spanId']) &&
            /^[0-9a-f]{32}$/.test(ref.traceId) &&
            /^[0-9a-f]{16}$/.test(ref.spanId),
        )
      );
    });
  if (!valid) throw new UatError('failed', 'evidence_privacy_violation');
}
