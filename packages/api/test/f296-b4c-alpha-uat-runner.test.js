import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  assertAlphaSnapshot,
  assertContentFreeManifest,
  boundEnum,
  metricsProveObservation,
  projectTraceEvidence,
  runAlphaUat,
  unsupportedJourney,
  validateAlphaCoordinates,
  validateCanonicalContract,
} from '../../../scripts/f296-alpha-uat.mjs';
import {
  CONTEXT_PROJECTION_ENUMS,
  CONTEXT_PROJECTION_TELEMETRY_CONTRACT,
} from '../dist/domains/cats/services/session/context-projection-telemetry-contract.js';

const revision = 'a'.repeat(40);
const traceId = 'b'.repeat(32);
const spanId = 'c'.repeat(16);

function throwsReason(fn, reason) {
  assert.throws(fn, (error) => error?.reason === reason);
}

function canonicalSpan(overrides = {}) {
  const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
  return {
    traceId,
    spanId,
    attributes: {
      [keys.provider]: 'codex',
      [keys.carrier]: 'app_server',
      [keys.disposition]: 'fresh',
      [keys.reason]: 'no_prior_session',
      [keys.transition]: 'scope_first_seen',
      [keys.mode]: 'cold',
      [keys.deltaSize]: 'small',
      [keys.tierT0Count]: 1,
      [keys.tierT0Bytes]: 4,
      [keys.tierT1Count]: 0,
      [keys.tierT1Bytes]: 0,
      [keys.tierT2Count]: 0,
      [keys.tierT2Bytes]: 0,
      [keys.tierInvalidCount]: 0,
      [keys.tierInvalidBytes]: 0,
      [keys.tierUnrecognizedCount]: 0,
      [keys.tierUnrecognizedBytes]: 0,
      [keys.deliveryLatencyMs]: 12,
      [keys.ledgerOutcome]: 'no_reservation',
      ...overrides,
    },
  };
}

function journey(observation, name = 'cold') {
  return {
    journey: name,
    outcome: observation ? 'passed' : 'unsupported',
    reason: observation ? 'observed' : 'telemetry_signal_missing',
    observation,
  };
}

describe('F296 B4c Alpha UAT runner red contracts', () => {
  test('imports and pins the compiled B4b canonical telemetry contract', () => {
    assert.doesNotThrow(() => validateCanonicalContract());
    const drifted = structuredClone(CONTEXT_PROJECTION_TELEMETRY_CONTRACT);
    drifted.traceAttributes.mode = 'drifted.attribute';
    throwsReason(() => validateCanonicalContract(drifted, CONTEXT_PROJECTION_ENUMS), 'contract_drift');
    const enumDrift = structuredClone(CONTEXT_PROJECTION_ENUMS);
    enumDrift.transitions.push('future-transition');
    throwsReason(() => validateCanonicalContract(CONTEXT_PROJECTION_TELEMETRY_CONTRACT, enumDrift), 'contract_drift');
  });

  test('has no fixture, store, synthetic trigger, or manual telemetry backdoor', async () => {
    const source = (
      await Promise.all([
        readFile(new URL('../../../scripts/f296-alpha-uat.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../../scripts/lib/f296-alpha-uat-contract.mjs', import.meta.url), 'utf8'),
      ])
    ).join('\n');
    for (const forbidden of [
      'ContextEpochOwner',
      'ContinuityDisposition',
      'compaction store',
      'presentation ledger',
      '__fixtures__',
      '/trigger',
      '/compact',
      '/replace',
      'recordContextProjection',
    ])
      assert.equal(source.includes(forbidden), false, `runner contains forbidden seam: ${forbidden}`);
    for (const copied of [
      ...Object.values(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.metricNames),
      ...Object.values(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes),
    ])
      assert.equal(source.includes(`'${copied}'`), false, `runner copied canonical telemetry string: ${copied}`);
  });

  test('rejects live, random, malformed, and Redis sanctuary coordinates', () => {
    assert.doesNotThrow(() => validateAlphaCoordinates('http://127.0.0.1:3012', 'redis://127.0.0.1:6398'));
    for (const api of [
      'http://127.0.0.1:3003',
      'http://127.0.0.1:3004',
      'http://127.0.0.1:3999',
      'http://localhost:3012',
    ]) {
      throwsReason(() => validateAlphaCoordinates(api, 'redis://127.0.0.1:6398'), 'wrong_api_origin');
    }
    for (const redis of ['redis://127.0.0.1:6399', 'redis://127.0.0.1:7777', 'redis://remote:6398']) {
      throwsReason(() => validateAlphaCoordinates('http://127.0.0.1:3012', redis), 'wrong_redis_endpoint');
    }
    for (const redis of ['rediss://127.0.0.1:6398', 'redis://user:secret@127.0.0.1:6398', 'redis://127.0.0.1:6398/1']) {
      throwsReason(() => validateAlphaCoordinates('http://127.0.0.1:3012', redis), 'wrong_redis_endpoint');
    }
  });

  test('fails closed on wrong deployment, degraded readiness, and a non-app-server canary', () => {
    const base = {
      expectedRevision: revision,
      health: { deploymentRevision: revision },
      readiness: { status: 'ready' },
      cats: { cats: [{ id: 'codex', clientId: 'openai', codexCarrier: { effective: 'app_server' } }] },
      catId: 'codex',
    };
    assert.doesNotThrow(() => assertAlphaSnapshot(base));
    throwsReason(
      () => assertAlphaSnapshot({ ...base, health: { deploymentRevision: 'd'.repeat(40) } }),
      'wrong_revision',
    );
    throwsReason(() => assertAlphaSnapshot({ ...base, readiness: { status: 'degraded' } }), 'alpha_not_ready');
    throwsReason(
      () =>
        assertAlphaSnapshot({
          ...base,
          cats: { cats: [{ id: 'codex', clientId: 'openai', codexCarrier: { effective: 'exec_json' } }] },
        }),
      'canary_not_app_server',
    );
  });

  test('polls the real trace read until the completed invocation span is exported', async (t) => {
    const originalFetch = globalThis.fetch;
    const sessionCookie = `cat_cafe_session=${'1'.repeat(64)}`;
    const deployedRevision = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
    const traceReads = new Map();
    let invocationNumber = 0;
    let metricsValue = 0;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const metricText = (value) => {
      const projection = projectTraceEvidence(canonicalSpan());
      const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
      const name = (entry) => entry.replaceAll('.', '_');
      const attrs = contract.metricAttributes;
      const labels = [
        `${name(attrs.disposition)}="fresh"`,
        `${name(attrs.reason)}="no_prior_session"`,
        `${name(attrs.transition)}="scope_first_seen"`,
        `${name(attrs.mode)}="cold"`,
        `${name(attrs.deltaSize)}="small"`,
      ].join(',');
      return [
        `${name(contract.metricNames.transitionTotal)}{${labels}} ${value}`,
        `${name(contract.metricNames.deliveryLatency)}_count ${value}`,
        `${name(contract.metricNames.ledgerOutcomeTotal)}{${name(attrs.ledgerOutcome)}="no_reservation"} ${value}`,
        ...projection.evidence.tiers.flatMap(({ tier }) => [
          `${name(contract.metricNames.tierCount)}_count{${name(attrs.tier)}="${tier}"} ${value}`,
          `${name(contract.metricNames.tierBytes)}_count{${name(attrs.tier)}="${tier}"} ${value}`,
        ]),
      ].join('\n');
    };
    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/session') {
        return Response.json(
          { userId: 'default-user' },
          { headers: { 'set-cookie': `${sessionCookie}; Path=/; HttpOnly` } },
        );
      }
      if (url.pathname === '/health') return Response.json({ deploymentRevision: deployedRevision });
      if (url.pathname === '/ready') return Response.json({ status: 'ready' });
      if (url.pathname === '/api/cats') {
        return Response.json({
          cats: [{ id: 'codex', clientId: 'openai', codexCarrier: { effective: 'app_server' } }],
        });
      }
      if (url.pathname === '/api/threads') return Response.json({ id: 'canary-thread' });
      if (url.pathname === '/api/messages') {
        invocationNumber += 1;
        return Response.json({ status: 'processing', invocationId: `parent-${invocationNumber}` });
      }
      if (url.pathname.endsWith('/executions')) {
        const parentNumber = url.pathname.split('/').at(-2).split('-').at(-1);
        return Response.json({
          executionCount: 1,
          executions: [
            { invocationId: `child-${parentNumber}`, catId: 'codex', executionKind: 'ordinary', status: 'succeeded' },
          ],
        });
      }
      if (url.pathname.startsWith('/api/invocations/')) return Response.json({ status: 'succeeded' });
      if (url.pathname === '/api/telemetry/metrics') {
        metricsValue += 1;
        return new Response(metricText(metricsValue), { status: 200 });
      }
      if (url.pathname === '/api/telemetry/traces') {
        const invocationId = url.searchParams.get('invocationId');
        const count = (traceReads.get(invocationId) ?? 0) + 1;
        traceReads.set(invocationId, count);
        if (invocationId?.startsWith('parent-')) return Response.json({ spans: [], count: 0 });
        if (invocationId === 'child-1' && count === 1) return Response.json({ spans: [], count: 0 });
        return Response.json({ spans: [canonicalSpan()], count: 1 });
      }
      return Response.json({}, { status: 404 });
    };

    const manifest = await runAlphaUat({
      apiUrl: 'http://127.0.0.1:3012',
      redisUrl: 'redis://127.0.0.1:6398',
      catId: 'codex',
      userId: 'f296-alpha-uat',
      timeoutMs: 1000,
      pollMs: 100,
    });
    assert.equal(manifest.journeys[0].outcome, 'passed');
    assert.equal(traceReads.get('child-1'), 2);
    assert.equal(traceReads.has('parent-1'), false);
  });

  test('bounds unknown and future enum values to unrecognized', () => {
    assert.equal(boundEnum('future-transition', CONTEXT_PROJECTION_ENUMS.transitions), 'unrecognized');
    const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
    const projection = projectTraceEvidence(canonicalSpan({ [keys.transition]: 'future-transition' }));
    assert.equal(projection.evidence.transition, 'unrecognized');
  });

  test('missing real projection fields cannot become a passing observation', () => {
    assert.equal(projectTraceEvidence({ traceId, spanId, attributes: {} }), null);
    const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
    assert.equal(projectTraceEvidence(canonicalSpan({ [keys.deliveryLatencyMs]: undefined })), null);
    assert.deepEqual(unsupportedJourney('cold', 'telemetry_signal_missing'), {
      journey: 'cold',
      outcome: 'unsupported',
      reason: 'telemetry_signal_missing',
      observation: null,
    });
  });

  test('requires positive deltas from every canonical B4b metric family', () => {
    const projection = projectTraceEvidence(canonicalSpan());
    const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
    const name = (value) => value.replaceAll('.', '_');
    const attrs = contract.metricAttributes;
    const labels = [
      `${name(attrs.disposition)}="fresh"`,
      `${name(attrs.reason)}="no_prior_session"`,
      `${name(attrs.transition)}="scope_first_seen"`,
      `${name(attrs.mode)}="cold"`,
      `${name(attrs.deltaSize)}="small"`,
    ].join(',');
    const rows = [
      `${name(contract.metricNames.transitionTotal)}{${labels}} 1`,
      `${name(contract.metricNames.deliveryLatency)}_count 1`,
      `${name(contract.metricNames.ledgerOutcomeTotal)}{${name(attrs.ledgerOutcome)}="no_reservation"} 1`,
      ...projection.evidence.tiers.flatMap(({ tier }) => [
        `${name(contract.metricNames.tierCount)}_count{${name(attrs.tier)}="${tier}"} 1`,
        `${name(contract.metricNames.tierBytes)}_count{${name(attrs.tier)}="${tier}"} 1`,
      ]),
    ];
    assert.equal(metricsProveObservation('', rows.join('\n'), projection), true);
    assert.equal(metricsProveObservation('', rows.slice(1).join('\n'), projection), false);
  });

  test('rejects any prompt, content, user, thread, or subject field in the manifest', () => {
    const observation = projectTraceEvidence(canonicalSpan()).evidence;
    const manifest = {
      schemaVersion: 1,
      revision,
      journeys: [
        journey(observation),
        journey(observation, 'resumed-small'),
        journey(observation, 'resumed-large'),
        journey(null, 'replacement'),
        { ...journey(null, 'authoritative-compaction'), reason: 'provider_compaction_trigger_unavailable' },
      ],
    };
    manifest.journeys[3].reason = 'provider_replacement_trigger_unavailable';
    assert.doesNotThrow(() => assertContentFreeManifest(manifest));
    for (const leakedKey of ['prompt', 'content', 'userId', 'threadId', 'subjectId', 'reasoning']) {
      const leaked = structuredClone(manifest);
      leaked.journeys[0].observation[leakedKey] = 'secret';
      throwsReason(() => assertContentFreeManifest(leaked), 'evidence_privacy_violation');
    }
    const unbounded = structuredClone(manifest);
    unbounded.journeys[0].observation.mode = 'future-mode';
    throwsReason(() => assertContentFreeManifest(unbounded), 'evidence_privacy_violation');
  });
});
