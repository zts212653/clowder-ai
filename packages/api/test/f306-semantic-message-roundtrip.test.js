import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { safeParseExtra, serializeExtra } = await import(
  '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
);

const semanticEvent = {
  v: 1,
  id: 'review-result-1',
  kind: 'review',
  occurredAt: 1_788_000_000_000,
  reviewId: 'review-1',
  stage: 'result',
  summary: '没有阻塞项。',
  target: { kind: 'base_branch', branch: 'origin/main' },
  delivery: 'detached',
  provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'review/result' },
};

describe('F306 durable semantic message carrier', () => {
  it('round-trips provider-neutral events through the Redis whitelist', () => {
    assert.deepEqual(safeParseExtra(serializeExtra({ semanticEvent })), { semanticEvent });
  });

  it('fails closed for provider wire envelopes and malformed semantic payloads', () => {
    assert.equal(safeParseExtra(JSON.stringify({ semanticEvent: { method: 'review/start', params: {} } })), undefined);
    assert.equal(safeParseExtra(JSON.stringify({ semanticEvent: { ...semanticEvent, summary: '' } })), undefined);
  });
});
