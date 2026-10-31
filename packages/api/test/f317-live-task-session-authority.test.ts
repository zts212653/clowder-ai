import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { createLiveTaskAuthority } from '../src/routes/live-task-authority.js';

async function fixture(householdToolsEnabled = true) {
  const sessions = new LiveCompanionSessions();
  let verify = async () => true;
  const catId = createCatId('codex61-sol');
  const actor = { userId: 'owner', threadId: 'home', invocationId: 'live-invocation', catId };
  const turns = new InMemoryTurnExecutionStore();
  turns.createRunning({
    ...actor,
    parentInvocationId: 'parent',
    executionKind: 'ordinary',
    startedAt: Date.now(),
    queueCompletionPolicy: 'explicit_source',
  });
  turns.createRunning({
    ...actor,
    invocationId: 'ordinary',
    parentInvocationId: 'parent-ordinary',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  const call = await sessions.prepare({
    binding: { userId: actor.userId, threadId: actor.threadId, catId, callId: 'call' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    verifyCompanion: () => verify(),
    householdToolsEnabled,
    publish() {},
  });
  async function start() {
    await sessions.claim(call.id, actor.userId, actor.threadId, [actor.catId]);
    await call.configure({
      CAT_CAFE_API_URL: 'http://127.0.0.1:5227',
      CAT_CAFE_USER_ID: actor.userId,
      CAT_CAFE_THREAD_ID: actor.threadId,
      CAT_CAFE_CAT_ID: catId,
      CAT_CAFE_INVOCATION_ID: actor.invocationId,
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
    });
    await call.ready('root', {
      submitText: async () => 'turn',
      request: async (method) => {
        if (method === 'thread/realtime/start') {
          await call.observe({
            method: 'thread/realtime/started',
            params: { threadId: 'root', realtimeSessionId: 'rtc' },
          });
          await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'root', sdp: 'answer' } });
        }
        if (method === 'thread/realtime/stop')
          await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'root' } });
        return {};
      },
    });
    await call.start('synthetic-offer');
  }
  return {
    sessions,
    start,
    call,
    actor,
    authority: createLiveTaskAuthority(sessions, turns),
    setVerify: (next: () => Promise<boolean>) => {
      verify = next;
    },
  };
}

test('production Task adapter uses the actual turn policy and the claimed owner/current Session', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.authority.isLive(f.actor), true);
    assert.equal(await f.authority.isLive({ ...f.actor, invocationId: 'ordinary' }), false);
    assert.equal(await f.authority.isLive({ ...f.actor, invocationId: 'missing' }), false);
    await assert.rejects(f.authority.assertCurrent(f.actor));
    await f.start();
    await f.authority.assertCurrent(f.actor);
    for (const actor of [
      { ...f.actor, userId: 'foreign' },
      { ...f.actor, threadId: 'foreign' },
      { ...f.actor, invocationId: 'foreign' },
      { ...f.actor, catId: createCatId('sonnet') },
    ])
      await assert.rejects(f.authority.assertCurrent(actor));
    assert.equal(
      await f.authority.run(f.actor, async () => {
        await f.authority.assertCurrent(f.actor);
        return 'accepted';
      }),
      'accepted',
    );
    f.setVerify(async () => {
      await f.call.stop();
      return true;
    });
    await assert.rejects(
      f.authority.assertCurrent(f.actor),
      undefined,
      'stop during real companion verification revokes the write',
    );
    await assert.rejects(f.authority.run(f.actor, async () => 'forbidden'));
  } finally {
    await f.sessions.close();
  }
});

test('a claimed real Session without household tools cannot admit Task mutations', async () => {
  const f = await fixture(false);
  try {
    await f.start();
    await assert.rejects(f.authority.assertCurrent(f.actor));
  } finally {
    await f.sessions.close();
  }
});
