import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const MESSAGE_BUNDLE = {
  v: 1,
  sourceThreadId: 'thread-source',
  items: [{ kind: 'message', messageId: 'message-source-1' }],
};

describe('durable message extra carriers survive Redis round-trips', () => {
  it('F294 preserves a Message Bundle while tracing metadata is merged', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const hydrated = safeParseExtra(serializeExtra({ messageBundle: MESSAGE_BUNDLE }));
    const input = {
      ...hydrated,
      tracing: {
        traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
        spanId: '1122334455667788',
      },
    };

    assert.deepEqual(safeParseExtra(serializeExtra(input)), input);
  });

  it('F294 drops a malformed Message Bundle without dropping valid sibling metadata', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        messageBundle: { ...MESSAGE_BUNDLE, items: [{ kind: 'message', messageId: '' }] },
        targetCats: ['opus'],
      }),
    );

    assert.deepEqual(parsed?.targetCats, ['opus']);
    assert.equal(parsed?.messageBundle, undefined);
  });

  it('preserves the other typed durable carriers declared by StoredMessage.extra', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      proactive: { visitId: 'visit-1', intentId: 'intent-1', source: 'private_time' },
      meetingArtifact: {
        intakeId: 'intake-1',
        sourceHandle: 'meeting://source-1',
        trust: 'untrusted_external',
        instructionPolicy: 'data_only',
      },
    };

    assert.deepEqual(safeParseExtra(serializeExtra(input)), input);
  });

  it('fails closed on malformed proactive and meeting-artifact carriers', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        proactive: { visitId: '', intentId: 'intent-1', source: 'private_time' },
        meetingArtifact: {
          intakeId: 'intake-1',
          sourceHandle: 'meeting://source-1',
          trust: 'trusted',
          instructionPolicy: 'data_only',
        },
        isExplicitPost: true,
      }),
    );

    assert.equal(parsed?.proactive, undefined);
    assert.equal(parsed?.meetingArtifact, undefined);
    assert.equal(parsed?.isExplicitPost, true);
  });
});
