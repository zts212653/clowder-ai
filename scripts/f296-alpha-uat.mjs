#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALPHA_API_ORIGIN,
  assertAlphaSnapshot,
  assertContentFreeManifest,
  metricsProveObservation,
  projectTraceEvidence,
  UatError,
  unsupportedJourney,
  validateAlphaCoordinates,
  validateCanonicalContract,
} from './lib/f296-alpha-uat-contract.mjs';
import { runCompactionJourney, runReplacementJourney } from './lib/f296-alpha-uat-journeys.mjs';

export * from './lib/f296-alpha-uat-contract.mjs';
export { cursorDidNotRewind } from './lib/f296-alpha-uat-journeys.mjs';

export const RESUMED_LARGE_CONTENT = `${'context-token '.repeat(5500)}\nReply with the single word OK.`;

function parseArgs(argv) {
  const options = {
    apiUrl: ALPHA_API_ORIGIN,
    redisUrl: 'redis://127.0.0.1:6398',
    catId: 'codex',
    userId: 'f296-alpha-uat',
    timeoutMs: 300000,
    pollMs: 1000,
    oversizedNativeThreadIds: [],
  };
  const fields = new Map([
    ['--api-url', 'apiUrl'],
    ['--redis-url', 'redisUrl'],
    ['--cat-id', 'catId'],
    ['--user-id', 'userId'],
    ['--timeout-ms', 'timeoutMs'],
    ['--poll-ms', 'pollMs'],
    ['--oversized-native-thread-id', 'oversizedNativeThreadIds'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    const field = fields.get(key);
    if (!field || !value) throw new UatError('failed', 'api_unavailable');
    if (field === 'oversizedNativeThreadIds') options.oversizedNativeThreadIds.push(value);
    else options[field] = field.endsWith('Ms') ? Number(value) : value;
  }
  if (
    !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(options.catId) ||
    !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(options.userId) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1000 ||
    options.timeoutMs > 1_800_000 ||
    !Number.isSafeInteger(options.pollMs) ||
    options.pollMs < 100 ||
    options.pollMs > 10_000 ||
    options.oversizedNativeThreadIds.some(
      (value) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    )
  ) {
    throw new UatError('failed', 'invalid_options');
  }
  return options;
}

async function request(options, path, init = {}) {
  let response;
  try {
    response = await fetch(`${options.apiUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'x-cat-cafe-user': options.userId,
        ...(options.sessionCookie ? { cookie: options.sessionCookie } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new UatError('failed', 'api_unavailable');
  }
  return response;
}

async function json(options, path, init, reason = 'api_unavailable') {
  const response = await request(options, path, init);
  if (!response.ok) throw new UatError('failed', reason);
  try {
    return await response.json();
  } catch {
    throw new UatError('failed', reason);
  }
}

async function establishSession(options) {
  const response = await request(options, '/api/session');
  const sessionCookie = response.headers.get('set-cookie')?.split(';', 1)[0]?.trim();
  let session;
  try {
    session = await response.json();
  } catch {
    throw new UatError('failed', 'api_unavailable');
  }
  if (
    !response.ok ||
    !/^cat_cafe_session=[0-9a-f]{64}$/.test(sessionCookie ?? '') ||
    !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(session?.userId)
  ) {
    throw new UatError('failed', 'api_unavailable');
  }
  return { ...options, userId: session.userId, sessionCookie };
}

async function metrics(options) {
  const response = await request(options, '/api/telemetry/metrics');
  if (!response.ok) throw new UatError('unsupported', 'telemetry_unavailable');
  return response.text();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorOutcome(error) {
  return typeof error?.outcome === 'string' ? error.outcome : 'failed';
}

function errorReason(error) {
  return typeof error?.reason === 'string' ? error.reason : 'api_unavailable';
}

async function awaitInvocation(options, invocationId) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const record = await json(options, `/api/invocations/${encodeURIComponent(invocationId)}`);
    if (record.status === 'succeeded') return;
    if (['failed', 'canceled', 'canceled_by_user'].includes(record.status))
      throw new UatError('failed', 'invocation_failed');
    await delay(options.pollMs);
  }
  throw new UatError('failed', 'invocation_timeout');
}

export function selectProviderExecution(executions, catId) {
  return (
    executions?.find(
      (item) =>
        item?.catId === catId &&
        item.executionKind === 'ordinary' &&
        item.status === 'succeeded' &&
        typeof item.invocationId === 'string',
    ) ?? null
  );
}

async function awaitProviderInvocation(options, parentInvocationId) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(options, `/api/invocations/${encodeURIComponent(parentInvocationId)}/executions`);
    if (response.status === 404) {
      await delay(options.pollMs);
      continue;
    }
    if (!response.ok) throw new UatError('unsupported', 'telemetry_unavailable');
    let body;
    try {
      body = await response.json();
    } catch {
      throw new UatError('unsupported', 'telemetry_unavailable');
    }
    const execution = selectProviderExecution(body.executions, options.catId);
    if (execution) return execution.invocationId;
    await delay(options.pollMs);
  }
  return null;
}

async function awaitProjection(options, invocationId) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const traceResponse = await request(
      options,
      `/api/telemetry/traces?invocationId=${encodeURIComponent(invocationId)}&limit=100`,
    );
    if (!traceResponse.ok) throw new UatError('unsupported', 'telemetry_unavailable');
    let traces;
    try {
      traces = await traceResponse.json();
    } catch {
      throw new UatError('unsupported', 'telemetry_unavailable');
    }
    const projection = traces.spans?.map(projectTraceEvidence).find(Boolean) ?? null;
    if (projection) return projection;
    await delay(options.pollMs);
  }
  return null;
}

async function observe(options, threadId, journey, content, expected) {
  const before = await metrics(options);
  const sent = await json(
    options,
    '/api/messages',
    {
      method: 'POST',
      body: JSON.stringify({
        threadId,
        mentions: [options.catId],
        content: `@${options.catId}\n${content}`,
        deliveryMode: 'immediate',
      }),
    },
    'invocation_rejected',
  );
  if (sent.status !== 'processing' || typeof sent.invocationId !== 'string')
    throw new UatError('failed', 'invocation_rejected');
  return observeInvocation(options, sent.invocationId, journey, expected, before);
}

async function observeInvocation(options, parentInvocationId, journey, expected, before) {
  await awaitInvocation(options, parentInvocationId);
  const providerInvocationId = await awaitProviderInvocation(options, parentInvocationId);
  if (!providerInvocationId) return unsupportedJourney(journey, 'telemetry_signal_missing');
  const projection = await awaitProjection(options, providerInvocationId);
  if (!projection) return unsupportedJourney(journey, 'telemetry_signal_missing');
  const after = await metrics(options);
  if (!metricsProveObservation(before, after, projection))
    return unsupportedJourney(journey, 'metric_signal_missing', projection.evidence);
  const actual = {
    ...projection.internal,
    mode: projection.evidence.mode,
    reason: projection.evidence.reason,
    transition: projection.evidence.transition,
    delta: projection.evidence.delta,
  };
  const matches =
    Object.entries(expected).every(([key, value]) => actual[key] === value) &&
    actual.provider === 'codex' &&
    actual.carrier === 'app_server';
  return {
    journey,
    outcome: matches ? 'passed' : 'failed',
    reason: matches ? 'observed' : 'continuity_mismatch',
    observation: projection.evidence,
  };
}

function dynamicPresentation(cold) {
  const observation = cold.observation;
  if (observation === null || observation === undefined) {
    return {
      outcome: cold.outcome,
      reason: cold.reason,
      observation: null,
    };
  }
  const observed =
    observation?.ledgerTerminal === 'committed' && observation.tiers.some(({ count }) => Number(count) > 0);
  return {
    outcome: observed ? 'passed' : 'failed',
    reason: observed ? 'observed' : 'dynamic_presentation_mismatch',
    observation: observation === undefined ? null : observation,
  };
}

async function observeColdAndDynamic(options, threadId, expectedRevision, expected) {
  const before = await metrics(options);
  const response = await request(options, `/api/threads/${encodeURIComponent(threadId)}/f296-alpha-dynamic-canary`, {
    method: 'POST',
    body: JSON.stringify({ runId: expectedRevision }),
  });
  if ([404, 409].includes(response.status)) {
    return {
      cold: await observe(options, threadId, 'cold', 'Reply with the single word OK.', expected),
      dynamic: {
        outcome: 'unsupported',
        reason: 'canonical_dynamic_producer_unavailable',
        observation: null,
      },
    };
  }
  let carrier;
  try {
    carrier = await response.json();
  } catch {
    carrier = null;
  }
  if (
    !response.ok ||
    carrier?.status !== 'processing' ||
    typeof carrier.invocationId !== 'string' ||
    carrier.producer !== 'meeting_artifact' ||
    carrier.opportunityKind !== 'memory_write_opportunity'
  ) {
    return {
      cold: await observe(options, threadId, 'cold', 'Reply with the single word OK.', expected),
      dynamic: { outcome: 'failed', reason: 'dynamic_presentation_mismatch', observation: null },
    };
  }
  const cold = await observeInvocation(options, carrier.invocationId, 'cold', expected, before);
  return { cold, dynamic: dynamicPresentation(cold) };
}

async function captureColdAndDynamic(options, threadId, expectedRevision, expected) {
  try {
    return await observeColdAndDynamic(options, threadId, expectedRevision, expected);
  } catch (error) {
    const cold = {
      journey: 'cold',
      outcome: errorOutcome(error),
      reason: errorReason(error),
      observation: null,
    };
    return {
      cold,
      dynamic: dynamicPresentation(cold),
    };
  }
}

async function createCanaryThread(options, title) {
  const thread = await json(
    options,
    '/api/threads',
    { method: 'POST', body: JSON.stringify({ title, preferredCats: [options.catId] }) },
    'thread_creation_failed',
  );
  if (typeof thread.id !== 'string' || thread.id.length === 0) throw new UatError('failed', 'thread_creation_failed');
  return thread.id;
}

export async function runAlphaUat(options) {
  validateCanonicalContract();
  validateAlphaCoordinates(options.apiUrl, options.redisUrl);
  const expectedRevision = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
  const sessionOptions = await establishSession(options);
  const [health, readiness, cats] = await Promise.all([
    json(sessionOptions, '/health'),
    json(sessionOptions, '/ready'),
    json(sessionOptions, '/api/cats'),
  ]);
  assertAlphaSnapshot({ expectedRevision, health, readiness, cats, catId: options.catId });
  await metrics(sessionOptions);
  const threadId = await createCanaryThread(sessionOptions, 'F296 B4c Alpha UAT canary');
  const specs = [
    [
      'resumed-small',
      'Reply with the single word OK again.',
      { disposition: 'resumed', reason: 'resume_confirmed', transition: 'resumed', mode: 'hot', delta: 'small' },
    ],
    [
      'resumed-large',
      RESUMED_LARGE_CONTENT,
      { disposition: 'resumed', reason: 'resume_confirmed', transition: 'resumed', mode: 'hot', delta: 'large' },
    ],
  ];
  const coldExpected = {
    disposition: 'fresh',
    reason: 'no_prior_session',
    transition: 'scope_first_seen',
    mode: 'cold',
    delta: 'small',
  };
  const coldAndDynamic = await captureColdAndDynamic(sessionOptions, threadId, expectedRevision, coldExpected);
  const journeys = [coldAndDynamic.cold];
  for (const [journey, content, expected] of specs) {
    if (journeys.some((item) => item.outcome !== 'passed')) {
      journeys.push(unsupportedJourney(journey, 'prerequisite_not_observed'));
      continue;
    }
    try {
      journeys.push(await observe(sessionOptions, threadId, journey, content, expected));
    } catch (error) {
      journeys.push({
        journey,
        outcome: error.outcome ?? 'failed',
        reason: error.reason ?? 'api_unavailable',
        observation: null,
      });
    }
  }
  try {
    journeys.push(await runReplacementJourney({ options: sessionOptions, createCanaryThread, json, observe }));
  } catch (error) {
    journeys.push({
      journey: 'replacement',
      outcome: error.outcome ?? 'failed',
      reason: error.reason ?? 'api_unavailable',
      observation: null,
    });
  }
  try {
    journeys.push(await runCompactionJourney({ options: sessionOptions, threadId, request, observe }));
  } catch (error) {
    journeys.push({
      journey: 'authoritative-compaction',
      outcome: error.outcome ?? 'failed',
      reason: error.reason ?? 'api_unavailable',
      observation: null,
    });
  }
  const manifest = {
    schemaVersion: 2,
    revision: expectedRevision,
    dynamicPresentation: coldAndDynamic.dynamic,
    journeys,
  };
  assertContentFreeManifest(manifest);
  return manifest;
}

async function main() {
  try {
    const manifest = await runAlphaUat(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    if (
      manifest.dynamicPresentation.outcome === 'failed' ||
      manifest.journeys.some((item) => item.outcome === 'failed')
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 2, outcome: errorOutcome(error), reason: errorReason(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
