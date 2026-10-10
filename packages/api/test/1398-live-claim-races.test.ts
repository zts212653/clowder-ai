import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';

async function fixture(t, verifyCompanion = async () => true) {
  const sessions = new LiveCompanionSessions();
  const call = await sessions.prepare({
    binding: { userId: 'owner', threadId: 'thread', catId: 'codex', callId: 'call' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    verifyCompanion,
    publish() {},
  });
  t.after(() => sessions.close());
  return { sessions, call, claim: () => sessions.claim(call.id, 'owner', 'thread', ['codex']) };
}
for (const scenario of ['stop', 'preferences', 'selection']) {
  test(`Live claim revalidates ${scenario} after asynchronous companion verification`, async (t) => {
    let verify;
    let verifying;
    const started = new Promise<void>((resolve) => {
      verifying = resolve;
    });
    const { sessions, call, claim } = await fixture(t, () => {
      verifying();
      return new Promise((resolve) => {
        verify = resolve;
      });
    });
    const pending = Promise.resolve().then(claim);
    await started;
    let preference;
    let save;
    if (scenario === 'stop') await call.stop();
    if (scenario === 'preferences') {
      preference = sessions.withOwnerPreferenceChange(
        'owner',
        () =>
          new Promise((resolve) => {
            save = resolve;
          }),
        async () => false,
      );
    }
    verify(scenario !== 'selection');
    await assert.rejects(pending, /admission mismatch/i);
    if (preference) {
      save();
      await preference;
    }
  });
}
test('two asynchronous claims of one handle have exactly one winner; bad scope cannot consume it', async (t) => {
  const { sessions, call, claim } = await fixture(t);
  for (const [owner, thread, cats] of [
    ['other', 'thread', ['codex']],
    ['owner', 'other', ['codex']],
    ['owner', 'thread', ['opus']],
    ['owner', 'thread', ['codex', 'opus']],
  ]) {
    await assert.rejects(
      Promise.resolve().then(() => sessions.claim(call.id, owner, thread, cats)),
      /admission mismatch/i,
    );
  }
  const outcomes = await Promise.allSettled([claim(), claim()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(call.status().state, 'preparing');
});
