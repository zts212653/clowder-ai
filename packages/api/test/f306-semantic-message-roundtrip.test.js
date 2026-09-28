import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { safeParseExtra, safeParseMetadata, serializeExtra } = await import(
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

describe('F306 durable subexecution metadata', () => {
  const subexecution = {
    v: 1,
    id: 'subexecution:child-1:message-1',
    kind: 'subexecution',
    occurredAt: 123,
    stage: 'message',
    subexecutionId: 'child-1',
    rootExecutionId: 'root-1',
    parentExecutionId: 'root-1',
    rootTurnId: 'root-turn-1',
    parentTurnId: 'root-turn-1',
    turnId: 'child-turn-1',
    agentPath: '/root/reviewer',
    nickname: 'Bohr',
    depth: 1,
    content: 'Independent result',
    messagePhase: 'final_answer',
    provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'subAgentActivity' },
  };

  it('round-trips bounded child identity with provider metadata', () => {
    const metadata = { provider: 'openai', model: 'gpt-6-astra', subexecutionEvents: [subexecution] };
    assert.deepEqual(safeParseMetadata(JSON.stringify(metadata)), metadata);
  });

  it('drops malformed child identity without discarding ordinary provider metadata', () => {
    assert.deepEqual(
      safeParseMetadata(
        JSON.stringify({
          provider: 'openai',
          model: 'gpt-6-astra',
          subexecutionEvents: [{ ...subexecution, parentTurnId: '', rawEnvelope: { method: 'turn/completed' } }],
        }),
      ),
      { provider: 'openai', model: 'gpt-6-astra' },
    );
  });
});

describe('F306 realtime companion provenance carrier', () => {
  const realtimeCompanion = {
    consumer: 'meeting_companion',
    invocationId: 'realtime-companion-123e4567-e89b-42d3-a456-426614174000',
  };

  it('round-trips the named consumer and bounded invocation through Redis', () => {
    assert.deepEqual(safeParseExtra(serializeExtra({ realtimeCompanion })), { realtimeCompanion });
  });

  it('drops malformed consumer and invocation provenance', () => {
    assert.equal(
      safeParseExtra(serializeExtra({ realtimeCompanion: { ...realtimeCompanion, consumer: 'raw_host' } })),
      undefined,
    );
    assert.equal(
      safeParseExtra(serializeExtra({ realtimeCompanion: { ...realtimeCompanion, invocationId: '../escape' } })),
      undefined,
    );
  });
});
