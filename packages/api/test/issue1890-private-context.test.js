import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';

const PRIVATE_CONTENT = 'private secret should not become public boundary';

// F35: debug mode intentionally exposes whispers to cats; play mode is the privacy contract.
test('callback full context hides an unaddressed whisper in play mode', async (t) => {
  const f = await createCallbackContextFixture(t, {
    threadStore: { get: async (id) => ({ id, thinkingMode: 'play' }) },
  });
  const source = await f.enqueue('private-context reviewer request');
  const admitted = await f.read();
  assert.equal(admitted.statusCode, 200, admitted.body);
  const privateMessage = await f.messages.append({
    userId: f.userId,
    threadId: f.threadId,
    from: { kind: 'user', userId: f.userId },
    content: PRIVATE_CONTENT,
    mentions: [],
    visibility: 'whisper',
    whisperTo: ['codex'],
    timestamp: Date.now(),
  });
  const full = await f.read();
  assert.equal(full.statusCode, 200, full.body);
  const responseProjection = full.json().messages.find((message) => message.id === f.response.id);
  assert.ok(responseProjection);
  assert.deepEqual(responseProjection.inputMessageIds, [source.message.id]);
  assert.equal(responseProjection.inputMessageIds.includes(privateMessage.id), false);
  assert.equal(full.body.includes(PRIVATE_CONTENT), false);
});
