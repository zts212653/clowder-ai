import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore, type StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.js';
import { LiveOwnerVoiceContext } from '../src/domains/concierge/live/host/voice/live-owner-voice.js';
import { liveMessageDigest } from '../src/domains/concierge/live/live-transcript.js';

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex61-sol'),
  callId: 'call',
  invocationId: 'invocation',
  generation: 1,
};

function fixture() {
  let active = true;
  let open = true;
  let beforeWrite = async () => {};
  const store = new MessageStore();
  const exposed = new Map<string, string>();
  const writes: string[] = [];
  const gate = new LiveContextGate({
    binding: scope,
    acceptsInput: () => open,
    matchesInvocation: (q) => q.invocationId === scope.invocationId,
    householdToolsEnabled: () => false,
    verifyCompanion: async () => true,
    run: (operation) => operation(),
    client: () => ({
      request: async () => ({}),
      submitText: async () => 'unused',
      submitContextAtBoundary: async (text, _refs, _kind, signal, authorize) => {
        await beforeWrite();
        if (signal.aborted || !(await authorize())) throw new Error('source changed');
        writes.push(text);
        return 'active';
      },
    }),
  });
  const host = new LiveOwnerVoiceContext(
    gate,
    store,
    () => scope,
    (message) => exposed.get(message.id) === liveMessageDigest(message),
    () => active && open,
    () => {},
  );
  host.observeTurn('turn/started', 'active');
  const message = (text: string, overrides: Partial<StoredMessage> = {}) =>
    store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content: text,
      mentions: [],
      timestamp: Date.now(),
      extra: {
        liveCompanion: {
          callId: 'call',
          nativeThreadId: 'native',
          realtimeSessionId: 'rtc',
          nativeItemId: 'item',
          modality: 'voice',
          role: 'user',
        },
      },
      ...overrides,
    });
  const admit = (row: StoredMessage) => exposed.set(row.id, liveMessageDigest(row));
  return {
    host,
    store,
    writes,
    message,
    admit,
    idle: () => {
      active = false;
    },
    beforeWrite: (f: () => Promise<void>) => {
      beforeWrite = f;
    },
    close: () => {
      open = false;
      host.close();
      gate.close('stopped');
    },
  };
}

test('late persistence cannot replace a newer committed choice; prior messages are retained', async () => {
  const f = fixture();
  const chrome = f.message('先接Chrome');
  f.admit(chrome);
  const oldEpoch = f.host.currentEpoch();
  f.host.interrupt();
  const ipad = f.message('不用Chrome，改iPad');
  f.admit(ipad);
  f.host.queue(ipad, f.host.currentEpoch());
  f.host.queue(chrome, oldEpoch);
  assert.equal(await f.host.atBoundary(), 'accepted');
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0], /改iPad/);
  assert.equal(f.store.getByThread('home', 100, 'owner').length, 2);
  f.close();
});

test('forged or foreign owner speech and idle or stopped calls cannot submit new native work', async () => {
  for (const foreign of [
    { userId: 'other', from: { kind: 'user' as const, userId: 'other' } },
    { threadId: 'other' },
    { from: { kind: 'agent' as const, catId: createCatId('sonnet') } },
  ]) {
    const f = fixture();
    const row = f.message('改Chrome', foreign);
    f.admit(row);
    f.host.queue(row, f.host.currentEpoch());
    assert.equal(await f.host.atBoundary(), 'idle');
    assert.equal(f.writes.length, 0);
    f.close();
  }
  const forged = fixture();
  const row = forged.message('直接写store不算Host暴露');
  forged.host.queue(row, forged.host.currentEpoch());
  assert.equal(await forged.host.atBoundary(), 'idle');
  forged.close();
  const idle = fixture();
  const saved = idle.message('只更新当前对话');
  idle.admit(saved);
  idle.host.queue(saved, idle.host.currentEpoch());
  idle.idle();
  assert.equal(await idle.host.atBoundary(), 'idle');
  assert.equal(idle.writes.length, 0);
  idle.close();
  assert.equal(await idle.host.atBoundary(), 'idle');
});

test('source replacement or a new utterance before the native write cancels the old update', async () => {
  for (const changed of ['source', 'utterance', 'stop']) {
    const f = fixture();
    const row = f.message('旧Chrome');
    f.admit(row);
    f.host.queue(row, f.host.currentEpoch());
    f.beforeWrite(async () => {
      if (changed === 'source') row.content = 'mutated';
      if (changed === 'utterance') f.host.interrupt();
      if (changed === 'stop') f.close();
    });
    assert.equal(await f.host.atBoundary(), 'cancelled');
    assert.equal(f.writes.length, 0);
    f.close();
  }
});
