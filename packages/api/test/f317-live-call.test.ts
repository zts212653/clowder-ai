import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { CodexAppServerJsonObject } from '../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';

test('a crashed desktop expires the Host call without needing another user message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'expired' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  assert.equal(call.householdToolsEnabled, true, 'Host duty must project the default household-read grant');
  t.mock.timers.tick(80_000);
  call.touchSurface();
  t.mock.timers.tick(80_000);
  assert.equal(call.status().state, 'preparing');
  t.mock.timers.tick(10_001);
  await assert.rejects(call.finished, /desktop lease expired/);
  assert.equal(call.status().state, 'failed');
});

test('voice-only startup tells the fast cat that household tools are not authorized', async () => {
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'voice-only' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    householdToolsEnabled: false,
    loadConversation: async () => 'RECENT_OWN_CONVERSATION',
    verifyNativeBinding: async () => true,
    publish() {},
  });
  assert.equal(call.householdToolsEnabled, false, 'voice-only duty must project the closed household-read grant');
  let instructions = '';
  await call.ready('native', {
    submitText: async () => 'unused',
    request: async (method, params) => {
      if (method === 'thread/realtime/start') {
        assert.match(String(params.prompt), /默认使用简体中文/);
        assert.match(String(params.prompt), /不要从账号、设备名/);
        assert.equal(
          params.codexResponseHandoffMode,
          'commentary',
          'native results must reach the conversational channel rather than hidden thinking',
        );
        instructions = String(params.prompt);
        assert.match(JSON.stringify(params.initialItems), /RECENT_OWN_CONVERSATION/);
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: 'native' } });
      return {};
    },
  });
  try {
    await call.start('offer');
    assert.match(instructions, /家内资料工具未授权、未接入/);
    assert.match(instructions, /只有实际工具成功返回并核对原文后/);
  } finally {
    await call.stop();
  }
});

test('a Host call starts native V3, persists spoken items and revokes its credentials before finishing', async () => {
  const store = new MessageStore();
  const published: string[] = [];
  const typed: Array<{ text: string; sourceMessageId: string }> = [];
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call' },
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async (id) => id === 'native',
    publish: (message) => published.push(message.id),
  });
  const observe = (method: string, fields: CodexAppServerJsonObject = {}) =>
    call.observe({ method, params: { threadId: 'native', ...fields } });
  const config = await call.configure({
    CAT_CAFE_API_URL: 'http://localhost:3012',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: 'codex-astra',
    CAT_CAFE_INVOCATION_ID: 'invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'token',
  });
  const servers = config.mcp_servers as Record<string, { env: Record<string, string> }>;
  const credentials = servers['cat-cafe-memory'].env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
  try {
    await observe('turn/started', { turn: { id: 'turn' } });
    await assert.rejects(
      call.ready('foreign', { request: async () => ({}), submitText: async () => 'unused' }),
      /binding/,
    );
    await call.ready('native', {
      submitText: async (text, sourceMessageId) => {
        if (text === 'reject') throw new Error('provider rejected');
        typed.push({ text, sourceMessageId });
        return 'turn';
      },
      request: async (method, params) => {
        if (method === 'thread/realtime/start') {
          assert.deepEqual(params.initialItems, [], 'no history must not manufacture a conversation item');
          assert.equal(typeof params.prompt, 'string', 'identity belongs to the native session prompt');
          await observe('thread/realtime/started', { realtimeSessionId: 'rtc' });
          await observe('thread/realtime/sdp', { sdp: 'answer' });
        }
        if (method === 'thread/realtime/stop') await observe('thread/realtime/closed');
        if (method === 'turn/interrupt') await observe('turn/completed', { turn: { id: 'turn' } });
        return {};
      },
    });
    assert.equal(await call.start('offer'), 'answer');
    const initialWork = call.status().nativeWork;
    assert.equal(call.status().nativeActivity, 'none');
    assert.deepEqual(initialWork.active, []);
    await observe('item/started', {
      turnId: 'turn',
      item: { id: 'screen-read', type: 'mcpToolCall', server: 'cat-cafe-selected-screen', tool: 'view_shared_screen' },
    });
    const activeWork = call.status().nativeWork;
    assert.equal(call.status().nativeActivity, 'tool_running');
    assert.equal(activeWork.active[0]?.kind, 'screen_read');
    assert.equal(call.status().nativeWork.active[0]?.taskId, activeWork.active[0]?.taskId);
    await observe('item/completed', { turnId: 'turn', item: { id: 'screen-read', type: 'mcpToolCall' } });
    assert.equal(call.status().nativeActivity, 'none');
    assert.equal(call.status().nativeWork.recent.at(-1)?.phase, 'completed');
    await observe('thread/realtime/item/completed', {
      item: { id: 'voice', realtimeSessionId: 'rtc', type: 'transcriptSegment', role: 'user', text: '合成测试' },
    });
    assert.equal(published.length, 1);
    const spoken = store.getById(published[0])!;
    assert.equal(call.exposureReason(spoken), 'same_live_call_exposure');
    assert.equal(call.exposureReason({ ...spoken, content: 'edited after exposure' }), null);
    assert.equal(
      call.exposureReason({
        ...spoken,
        extra: { liveCompanion: { ...spoken.extra!.liveCompanion!, callId: 'other-call' } },
      }),
      null,
    );
    assert.equal(call.exposureReason({ ...spoken, extra: {} }), null);
    await observe('item/completed', {
      turnId: 'turn',
      item: { id: 'native-answer', type: 'agentMessage', phase: 'final_answer', text: '已核对原文的完整答案' },
    });
    const answer = store.getById(published[1])!;
    assert.equal(answer.content, '已核对原文的完整答案');
    assert.equal(answer.extra?.liveCompanion?.modality, 'result');
    assert.equal(call.exposureReason(answer), 'same_live_call_exposure');
    const receipt = await call.sendText('补充条件', 'client-input');
    assert.equal(receipt.delivery, 'accepted');
    assert.deepEqual(typed, [{ text: '补充条件', sourceMessageId: receipt.messageId }]);
    assert.equal(call.exposureReason(store.getById(receipt.messageId)!), 'same_live_call_exposure');
    await assert.rejects(call.sendText('reject', 'rejected-input'), /provider rejected/);
    const rejected = store.getByIdempotencyKey('owner', 'home', 'live-text:call:rejected-input');
    assert.ok(rejected);
    assert.equal(call.exposureReason(rejected), null, 'persisted but rejected typed input remains unseen');
    const replay = await call.sendText('补充条件', 'client-input');
    assert.equal(replay.messageId, receipt.messageId);
    assert.equal(replay.delivery, 'accepted', 'a retry reuses this call’s actual native acknowledgement');
    assert.equal(typed.length, 1, 'a retried durable input must not start native execution twice');
    await assert.rejects(call.sendText('另一句话', 'client-input'), /identity conflict/);
    await call.stop();
    assert.equal(call.exposureReason(spoken), null);
    await call.finished;
    assert.equal(call.status().state, 'closed');
    await assert.rejects(readFile(credentials));
  } finally {
    await call.stop();
  }
});

test('stop during history restoration never starts Realtime or revives the closed call', async () => {
  let loaded!: () => void;
  let release!: (value: string) => void;
  const reading = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const history = new Promise<string>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'stopped-context' },
    messageStore: new MessageStore(),
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    loadConversation: () => {
      loaded();
      return history;
    },
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await call.ready('native', {
    request: async (method) => {
      requests.push(method);
      return {};
    },
    submitText: async () => 'unused',
  });
  const ended = assert.rejects(call.start('offer'), /ended during context loading/);
  await reading;
  await call.stop();
  release('old history');
  await ended;
  assert.equal(call.status().state, 'closed');
  assert.deepEqual(requests, [], 'no Realtime lifecycle RPC may precede history restoration');
});
