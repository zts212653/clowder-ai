import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadModule() {
  return import('../dist/domains/cats/services/runtime-session/RuntimeSessionMetadata.js');
}

function validMetadata(overrides = {}) {
  return {
    sessionId: 'session-1',
    runtime: 'antigravity-desktop',
    runtimeSessionId: 'cascade-1',
    runtimeConversationId: 'conversation-1',
    threadId: 'thread-1',
    catId: 'antig-opus',
    userId: 'user-1',
    surface: 'cat-cafe-dispatch',
    identityHistory: [
      {
        catId: 'antig-opus',
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        from: 1000,
        source: 'session_init',
      },
    ],
    lifecycle: {
      state: 'active',
      startedAt: 1000,
      lastObservedAt: 900,
    },
    ...overrides,
  };
}

describe('RuntimeSessionMetadata', () => {
  test('normalizes valid Antigravity Desktop metadata', async () => {
    const { normalizeRuntimeSessionMetadata } = await loadModule();

    const normalized = normalizeRuntimeSessionMetadata(validMetadata());

    assert.equal(normalized.sessionId, 'session-1');
    assert.equal(normalized.runtime, 'antigravity-desktop');
    assert.equal(normalized.runtimeSessionId, 'cascade-1');
    assert.equal(normalized.surface, 'cat-cafe-dispatch');
    assert.equal(normalized.lifecycle.state, 'active');
    assert.equal(normalized.lifecycle.startedAt, 1000);
    assert.equal(normalized.lifecycle.lastObservedAt, 1000, 'lastObservedAt should not precede startedAt');
    assert.deepEqual(normalized.identityHistory[0], {
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      from: 1000,
      source: 'session_init',
    });
  });

  test('rejects empty identifiers and invalid lifecycle state', async () => {
    const { normalizeRuntimeSessionMetadata } = await loadModule();

    assert.throws(
      () => normalizeRuntimeSessionMetadata(validMetadata({ sessionId: '' })),
      /sessionId must be a non-empty string/,
    );
    assert.throws(
      () => normalizeRuntimeSessionMetadata(validMetadata({ runtimeSessionId: '' })),
      /runtimeSessionId must be a non-empty string/,
    );
    assert.throws(
      () =>
        normalizeRuntimeSessionMetadata(
          validMetadata({
            lifecycle: {
              state: 'unknown-state',
              startedAt: 1000,
              lastObservedAt: 1000,
            },
          }),
        ),
      /invalid runtime session lifecycle state/,
    );
  });

  test('appends identity history without overlapping the previous segment', async () => {
    const { appendRuntimeIdentity, normalizeRuntimeSessionMetadata } = await loadModule();
    const metadata = normalizeRuntimeSessionMetadata(validMetadata());

    const updated = appendRuntimeIdentity(metadata, {
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      provider: 'google',
      from: 2000,
      source: 'trajectory',
    });

    assert.equal(metadata.identityHistory[0].to, undefined, 'append should not mutate the input metadata');
    assert.equal(updated.identityHistory.length, 2);
    assert.equal(updated.identityHistory[0].to, 2000, 'previous identity should close at the new start');
    assert.deepEqual(updated.identityHistory[1], {
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      provider: 'google',
      from: 2000,
      source: 'trajectory',
    });
  });

  test('rejects identity history appended before the current segment starts', async () => {
    const { appendRuntimeIdentity, normalizeRuntimeSessionMetadata } = await loadModule();
    const metadata = normalizeRuntimeSessionMetadata(validMetadata());

    assert.throws(
      () =>
        appendRuntimeIdentity(metadata, {
          catId: 'antigravity',
          model: 'gemini-3.1-pro',
          from: 999,
          source: 'trajectory',
        }),
      /identity segment starts before current segment/,
    );
  });
});
