import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId, resolveProviderSemanticMessage } from '@cat-cafe/shared';
import type { CodexSubexecutionEvent } from '../src/domains/cats/services/agents/providers/CodexSubexecutionIdentity.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';

async function fixture(start = true) {
  const store = new MessageStore();
  let current = true;
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex61-sol'), callId: 'call' },
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    verifyCompanion: async () => current,
    publish() {},
  });
  await call.ready('root', {
    submitText: async () => 'turn-root',
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'root', realtimeSessionId: 'voice' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'root', sdp: 'answer' } });
      }
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'root' } });
      if (method === 'turn/interrupt')
        await call.observe({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn-root' } } });
      return {};
    },
  });
  await call.observe({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'turn-root' } } });
  if (start) await call.start('offer');
  const receiver = call as LiveCompanionCall & { observeSubexecution?(event: CodexSubexecutionEvent): Promise<void> };
  return {
    call,
    store,
    revoke: () => {
      current = false;
    },
    observe: async (event: CodexSubexecutionEvent) => {
      if (receiver.observeSubexecution) await receiver.observeSubexecution(event);
      else await call.observe(event);
    },
  };
}

function child(stage: CodexSubexecutionEvent['stage'], time: number): CodexSubexecutionEvent {
  return {
    type: 'app_server.subexecution',
    event_id: `child-${stage}`,
    occurred_at: time,
    stage,
    subexecution_id: 'child',
    root_execution_id: 'root',
    parent_execution_id: 'root',
    root_turn_id: 'turn-root',
    parent_turn_id: 'turn-root',
    agent_path: '/root/reader',
    depth: 1,
    ...(stage !== 'started' ? { turn_id: 'turn-child' } : {}),
    ...(stage === 'message'
      ? { content: '仅根据父给出的两份材料，发现它们不是同一事项。', message_phase: 'final_answer' as const }
      : {}),
  };
}

test('Live durably records trusted child identity, native request, unknown time then actual terminal elapsed time', async () => {
  const f = await fixture();
  try {
    await f.observe(child('started', 1000));
    const later = await f.call.sendText('A separate follow-up', 'request-later');
    await f.observe(child('message', 1250));
    await f.observe(child('completed', 1500));
    await f.observe(child('completed', 1500));
    const messages = (await f.store.getByThread('home')).filter(
      (m) => m.metadata?.subexecutionEvents?.[0]?.kind === 'subexecution',
    );
    assert.equal(messages.length, 3, 'native subexecution facts must survive before the long root call ends');
    assert.deepEqual(
      messages.map((m) => m.metadata?.subexecutionEvents?.[0]?.stage),
      ['started', 'message', 'completed'],
    );
    assert.match(messages[0].content, /root\/turn-root/);
    assert.ok(
      messages.every((m) => !m.content.includes(`thread:home#${later.messageId}`)),
      'a later root input must not retrospectively become the admitted child request',
    );
    assert.match(messages[0].content, /未知/);
    assert.match(messages[2].content, /500/);
    assert.match(messages[2].content, /家内工具.*(受限|不可用)/);
    assert.ok(f.call.acceptsInput(), 'child completed never ends the root call');
    assert.equal(messages[1].metadata?.subexecutionEvents?.[0]?.kind, 'subexecution');
  } finally {
    await f.call.stop();
  }
});

test('foreign roots, missing start, revocation and post-stop child events cannot create Live records', async () => {
  const f = await fixture();
  await f.observe({ ...child('started', 1000), root_execution_id: 'foreign' });
  await f.observe(child('completed', 1500));
  assert.equal((await f.store.getByThread('home')).length, 0);
  f.revoke();
  await f.observe(child('started', 2000));
  assert.equal((await f.store.getByThread('home')).length, 0);
  await f.call.stop();
  await f.observe(child('message', 2500));
  assert.equal((await f.store.getByThread('home')).length, 0);
});

test('child records point to the acknowledged durable owner request and each resumed turn has its own end', async () => {
  const f = await fixture();
  try {
    const receipt = await f.call.sendText('Compare the two supplied reports', 'request-one');
    await f.observe(child('started', 1000));
    await f.observe(child('failed', 1500));
    await f.observe({ ...child('started', 2000), event_id: 'resume-two', turn_id: 'turn-child-2' });
    await f.observe({ ...child('message', 2250), event_id: 'result-two', turn_id: 'turn-child-2' });
    await f.observe({ ...child('interrupted', 2500), event_id: 'end-two', turn_id: 'turn-child-2' });
    const messages = (await f.store.getByThread('home')).filter(
      (m) => m.metadata?.subexecutionEvents?.[0]?.kind === 'subexecution',
    );
    assert.equal(messages.length, 5);
    assert.ok(
      messages.every((m) => m.content.includes(`thread:home#${receipt.messageId}`)),
      'root RPC receipt must bind the actual persisted request',
    );
    assert.match(messages[4].content, /开始：2000；结束：2500；耗时：500ms/);
    assert.ok(f.call.acceptsInput());
  } finally {
    await f.call.stop();
  }
});

test('concurrent replay commits and publishes one child fact', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.observe(child('started', 1000)), f.observe(child('started', 1000))]);
    assert.equal((await f.store.getByThread('home')).length, 1);
    await f.observe({ ...child('started', 2000), event_id: 'root-alias', subexecution_id: 'root' });
    assert.equal((await f.store.getByThread('home')).length, 1);
  } finally {
    await f.call.stop();
  }
});

test('an admitted child before the media connection is ready is recorded without a second execution', async () => {
  const f = await fixture(false);
  try {
    await f.observe(child('started', 1000));
    assert.equal((await f.store.getByThread('home')).length, 1);
    await f.call.start('offer');
    await f.observe(child('started', 1000));
    assert.equal((await f.store.getByThread('home')).length, 1);
  } finally {
    await f.call.stop();
  }
});

test('standalone Live usage records remain visible under the existing history suppression policy', async () => {
  const f = await fixture();
  try {
    await f.observe(child('started', 1000));
    await f.observe(child('message', 1250));
    await f.observe(child('completed', 1500));
    const records = await f.store.getByThread('home');
    const visible = records.filter(
      (m) => !m.extra?.semanticEvent || resolveProviderSemanticMessage(m.extra.semanticEvent).action !== 'suppress',
    );
    assert.equal(visible.length, 3, 'the existing history consumer must expose the accepted usage ledger');
    assert.ok(
      visible.every((m) => m.metadata?.subexecutionEvents?.length === 1),
      'retain the canonical F306 child identity',
    );
    assert.match(visible[2].content, /结果引用：thread:home#/);
  } finally {
    await f.call.stop();
  }
});
