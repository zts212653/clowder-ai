import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CodexActiveWriterRecoveryError } from '../src/domains/cats/services/runtime-session/CodexSessionReplacementProvenance.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';

test('native writer refusal remains readable without a carrier; retry and late old completion cannot replace the new call', async () => {
  const sessions = new LiveCompanionSessions();
  const messages = new MessageStore();
  const original = messages.append({
    userId: 'owner',
    threadId: 'home',
    catId: null,
    content: 'ordinary turn',
    mentions: [],
    timestamp: 1,
  });
  const options = {
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: randomUUID() },
    messageStore: messages,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  };
  const old = await sessions.prepare(options);
  const error = new CodexActiveWriterRecoveryError('private provider detail', {
    previousNativeThreadId: 'private-session',
    detectedAt: 1,
    diagnostics: {
      observedAt: 1,
      classification: 'external_or_unknown',
      confidence: 'low',
      localHostLease: { state: 'not_observed', source: 'carrier_affinity' },
      nativeThread: { readOutcome: 'failed', threadId: 'private-session', status: 'unknown' },
      writerClientIdentity: 'unavailable',
    },
  });
  await old.fail(error);
  await assert.rejects(old.finished, /private provider/);
  await Promise.resolve();
  assert.equal(sessions.get(old.id, 'owner'), undefined);
  assert.equal(sessions.readStatus(old.id, 'owner')?.failureCode, 'native_session_conflict');
  assert.equal(sessions.readStatus(old.id, 'foreign'), undefined);
  assert.equal(await sessions.observeCall('owner'), null);
  const next = await sessions.prepare({ ...options, binding: { ...options.binding, callId: randomUUID() } });
  try {
    await old.fail(new Error('late cleanup'));
    assert.equal(sessions.get(next.id, 'owner'), next);
    assert.equal(next.status().state, 'preparing');
    assert.deepEqual(
      (await messages.getByThread('home', 32, 'owner')).map((row) => row.id),
      [original.id],
    );
    await assert.rejects(
      old.ready('late-native', { request: async () => ({}), submitText: async () => 'late' }),
      /unavailable|ended/,
    );
    assert.equal(sessions.readStatus(old.id, 'owner')?.failureCode, 'native_session_conflict');
  } finally {
    await next.stop();
  }
});
