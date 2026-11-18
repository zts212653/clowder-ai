import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  observedCacheRetentionMs,
  observeSessionCache,
  projectSessionCacheWarmth,
} from '../src/domains/cats/services/session/cache/session-cache-warmth.js';

const now = 10_000_000;
function session() {
  return {
    id: 'session-1',
    catId: 'sonnet',
    threadId: 'thread-1',
    userId: 'owner-1',
    seq: 0,
    status: 'active',
    messageCount: 2,
    compressionCount: 0,
    createdAt: now - 10000,
    updatedAt: now,
    cliSessionId: 'native-1',
    lastUsage: {
      inputTokens: 200000,
      cacheObservation: {
        invocationId: 'invoke-1',
        nativeSessionId: 'native-1',
        runtime: 'anthropic:cli',
        model: 'sonnet-5-5',
        requestStartedAt: now - 120000,
        timeSource: 'invocation_start_lower_bound',
        observedAt: now - 60000,
        contextTokens: 200000,
        retentionMs: 3600000,
        retentionSource: 'usage_ttl',
        compressionCount: 0,
        confirmedWarmGapsMs: [],
      },
    },
  };
}

test('actual one-hour tier produces a bounded estimate from request start, not response completion', () => {
  const result = projectSessionCacheWarmth(session(), now);
  assert.equal(result.status, 'warm');
  assert.equal(result.expiresAt, now - 120000 + 3600000);
  assert.equal(result.contextTokens, 200000);
  assert.equal(result.estimated, true);
});

test('expired evidence never implies a new cold request was measured', () => {
  const result = projectSessionCacheWarmth(session(), now + 3600000);
  assert.equal(result.status, 'expired');
  assert.equal(result.source, 'usage_ttl');
});

test('a forty-minute invocation has an uncertain expiry interval before the observed upper bound', () => {
  const record = session();
  const observation = record.lastUsage.cacheObservation;
  observation.requestStartedAt = now - 40 * 60000;
  observation.observedAt = now;
  assert.equal(projectSessionCacheWarmth(record, now + 19 * 60000).status, 'warm');
  const uncertain = projectSessionCacheWarmth(record, now + 21 * 60000);
  assert.equal(uncertain.status, 'unknown');
  assert.equal(uncertain.reason, 'invocation_span_uncertain');
  assert.equal(uncertain.contextTokens, 200000);
  assert.equal(uncertain.latestExpiresAt, now + 60 * 60000);
  assert.equal(projectSessionCacheWarmth(record, now + 20 * 60000).status, 'unknown');
  assert.equal(projectSessionCacheWarmth(record, now + 60 * 60000).status, 'expired');
});

test('legacy missing evidence, native-session rollover and post-observation compression are unknown', () => {
  assert.equal(projectSessionCacheWarmth(null, now).status, 'unknown');
  const legacy = session();
  delete legacy.lastUsage.cacheObservation;
  assert.equal(projectSessionCacheWarmth(legacy, now).status, 'unknown');
  const rolled = session();
  rolled.cliSessionId = 'native-2';
  assert.equal(projectSessionCacheWarmth(rolled, now).status, 'unknown');
  const compacted = session();
  compacted.compressionCount = 1;
  assert.equal(projectSessionCacheWarmth(compacted, now).status, 'unknown');
});

test('mixed write tiers use the shortest observed window and runtime/model changes invalidate projections', () => {
  assert.equal(observedCacheRetentionMs({ cacheCreation1hTokens: 1000, cacheCreation5mTokens: 50 }), 300000);
  assert.equal(
    projectSessionCacheWarmth(session(), now, { model: 'different-model', runtime: 'anthropic:cli' }).status,
    'unknown',
  );
  assert.equal(
    projectSessionCacheWarmth(session(), now, { runtime: 'openai:app_server', model: 'sonnet-5-5' }).status,
    'unknown',
  );
});

test('unreported API turn count cannot turn aggregate cache hits into a proven idle interval', () => {
  const record = session();
  const observed = observeSessionCache({
    record,
    invocationId: 'invoke-2',
    runtime: 'anthropic:cli',
    model: 'sonnet-5-5',
    requestStartedAt: now + 3600000,
    observedAt: now + 3610000,
    contextTokens: 200000,
    usage: { inputTokens: 200000, cacheReadTokens: 200000 },
  });
  assert.deepEqual(observed?.confirmedWarmGapsMs, []);
});

test('repeated single-request matches learn only a scoped lower bound, never an eviction deadline', () => {
  const record = session();
  delete record.lastUsage.cacheObservation.retentionMs;
  delete record.lastUsage.cacheObservation.retentionSource;
  for (let i = 1; i <= 3; i++) {
    const requestStartedAt = now + i * 3600000;
    record.lastUsage.cacheObservation = observeSessionCache({
      record,
      invocationId: `invoke-${i + 1}`,
      runtime: 'anthropic:cli',
      model: 'sonnet-5-5',
      requestStartedAt,
      observedAt: requestStartedAt + 1000,
      contextTokens: 200000,
      usage: { inputTokens: 200000, cacheReadTokens: 200000, numTurns: 1 },
    });
  }
  const result = projectSessionCacheWarmth(record, now + 3 * 3600000 + 1000);
  assert.equal(result.status, 'warm');
  assert.equal(result.source, 'empirical_session');
  assert.ok(result.expiresAt !== undefined);
  assert.equal(projectSessionCacheWarmth(record, result.expiresAt + 1).status, 'unknown');
  const switched = observeSessionCache({
    record,
    invocationId: 'invoke-5',
    runtime: 'anthropic:cli',
    model: 'new-model',
    requestStartedAt: now + 4 * 3600000,
    observedAt: now + 4 * 3600000 + 1000,
    contextTokens: 200000,
    usage: { inputTokens: 200000, cacheReadTokens: 200000, numTurns: 1 },
  });
  assert.deepEqual(switched?.confirmedWarmGapsMs, []);
  assert.equal(switched?.retentionMs, undefined);
});
