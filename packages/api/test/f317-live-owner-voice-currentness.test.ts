import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore, type ThreadMessageReadOptions } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { voiceEnvelope } from './helpers/f317-ns-reg-live.js';

class TimelineMessageStore extends MessageStore {
  override getByThread(threadId: string, limit?: number, userId?: string, options?: ThreadMessageReadOptions) {
    return [...super.getByThread(threadId, limit, userId, options)].sort(
      (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
    );
  }
}

async function fixture(store = new TimelineMessageStore()) {
  const writes: string[] = [];
  let active: string | undefined;
  let beforeWrite = async () => {};
  let beforePersist = async () => {};
  let textAcceptance = async () => 'accepted-text';
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex61-sol'), callId: 'call' },
    householdToolsEnabled: false,
    messageStore: {
      appendIdempotent: async (message) => {
        await beforePersist();
        return store.appendIdempotent(message);
      },
      getById: (id) => store.getById(id),
      getByThread: (...args) => store.getByThread(...args),
      getByThreadAfter: (...args) => store.getByThreadAfter(...args),
    },
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await call.configure({
    CAT_CAFE_API_URL: 'http://localhost:3012',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: 'codex61-sol',
    CAT_CAFE_INVOCATION_ID: 'inv',
    CAT_CAFE_CALLBACK_TOKEN: 'test-token',
  });
  const turn = async (method: 'turn/started' | 'turn/completed', id: string) => {
    if (method === 'turn/started') active = id;
    if (method === 'turn/completed' && active === id) active = undefined;
    await call.observe({ method, params: { threadId: 'native', turn: { id } } });
  };
  await call.ready('native', {
    submitText: () => textAcceptance(),
    submitContextAtBoundary: async (text, _refs, _kind, signal, authorize) => {
      await beforeWrite();
      if (signal.aborted || !(await authorize())) throw new Error('source superseded');
      writes.push(text);
      return 'active';
    },
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      if (method === 'turn/interrupt' && active) await turn('turn/completed', active);
      return {};
    },
  });
  await call.start('offer');
  const textRow = (content: string, timestamp = Date.now(), deliveryStatus?: 'queued') => {
    return store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content,
      mentions: [],
      timestamp,
      ...(deliveryStatus ? { deliveryStatus } : {}),
    });
  };
  return {
    call,
    store,
    writes,
    turn,
    textRow,
    voice: (text: string, item = 'speech') => call.observe(voiceEnvelope('rtc', 'user', item, text, 'native')),
    delta: () =>
      call.observe({
        method: 'thread/realtime/transcript/delta',
        params: { threadId: 'native', role: 'user', delta: '改' },
      }),
    beforeWrite: (operation: () => Promise<void>) => {
      beforeWrite = operation;
    },
    beforePersist: (operation: () => Promise<void>) => {
      beforePersist = operation;
    },
    textAcceptance: (operation: () => Promise<string>) => {
      textAcceptance = operation;
    },
    flush: () => call.onSafeBoundary('tool_complete'),
    close: () => call.stop(),
  };
}

test('A/D: speech committed while idle cannot enter a later inbox or typed native turn', async () => {
  for (const typed of [false, true]) {
    const f = await fixture();
    try {
      await f.voice('改成iPad');
      if (typed) await f.call.sendText('改回Chrome', 'typed');
      await f.turn('turn/started', typed ? 'typed-T2' : 'inbox-T2');
      await f.flush();
      assert.equal(f.writes.length, 0, 'idle speech cannot become current input for later work');
    } finally {
      await f.close();
    }
  }
});

test('B: pending speech is invalidated when its original native turn completes or is replaced', async () => {
  for (const completes of [false, true]) {
    const f = await fixture();
    try {
      await f.turn('turn/started', 'T1');
      await f.voice('改成iPad');
      if (completes) await f.turn('turn/completed', 'T1');
      await f.turn('turn/started', 'T2');
      await f.flush();
      assert.equal(f.writes.length, 0, 'pending source is bound to T1, not whichever turn exists later');
    } finally {
      await f.close();
    }
  }
});

test('E: actual accepted sendText clears pending speech within the same native turn', async () => {
  const f = await fixture();
  try {
    await f.turn('turn/started', 'T1');
    await f.voice('改成iPad');
    assert.equal(f.call.hasPendingOwnerVoiceWake(), true);
    assert.equal((await f.call.sendText('改回Chrome', 'typed')).delivery, 'accepted');
    assert.equal(f.call.hasPendingOwnerVoiceWake(), false, 'accepted new text cancels the old pending update');
    await f.flush();
    assert.equal(f.writes.length, 0);
    assert.equal(f.store.getByThread('home', 100, 'owner').length, 2, 'both original owner inputs remain');
  } finally {
    await f.close();
  }
});

test('C: a newer speech delta still invalidates the pending correction', async () => {
  const f = await fixture();
  try {
    await f.turn('turn/started', 'T1');
    await f.voice('改成iPad');
    await f.delta();
    await f.flush();
    assert.equal(f.writes.length, 0);
  } finally {
    await f.close();
  }
});

test('later persisted text supersedes pending speech even with a backdated timestamp or queued visibility', async () => {
  for (const queued of [false, true]) {
    const f = await fixture();
    try {
      await f.turn('turn/started', 'T1');
      await f.voice('改成iPad');
      f.textRow('改回Chrome', 1, queued ? 'queued' : undefined);
      await f.flush();
      assert.equal(f.writes.length, 0, `source currentness follows persistence: queued=${queued}`);
    } finally {
      await f.close();
    }
  }
});

test('a newer owner message persisted while waiting for the final native write rejects old speech', async () => {
  const f = await fixture();
  try {
    await f.turn('turn/started', 'T1');
    await f.voice('改成iPad');
    f.beforeWrite(async () => {
      f.textRow('改回Chrome', 1);
    });
    await f.flush();
    assert.equal(f.writes.length, 0, 'the latest owner source is checked again at the native write');
  } finally {
    await f.close();
  }
});

test('duplicate starts, foreign completion and another cat reply do not revoke the current owner correction', async () => {
  const f = await fixture();
  try {
    await f.turn('turn/started', 'T1');
    await f.voice('改成iPad');
    await f.turn('turn/started', 'T1');
    await f.turn('turn/completed', 'foreign');
    f.store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'agent', catId: createCatId('sonnet') },
      content: 'unrelated work',
      mentions: [],
      timestamp: Date.now(),
    });
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0], /改成iPad/);
  } finally {
    await f.close();
  }
});

test('an acknowledged typed replay does not cancel a later pending voice correction', async () => {
  const f = await fixture();
  try {
    await f.turn('turn/started', 'T1');
    await f.call.sendText('先查Chrome', 'typed');
    await f.voice('不用Chrome，改iPad');
    await f.call.sendText('先查Chrome', 'typed');
    await f.flush();
    assert.equal(f.writes.length, 1, 'idempotent text replay is not a new owner revision');
    assert.match(f.writes[0], /改iPad/);
  } finally {
    await f.close();
  }
});

test('late acceptance of an earlier typed source does not erase a newer spoken revision', async () => {
  const f = await fixture();
  let accept!: (turn: string) => void;
  let submitted!: () => void;
  const pending = new Promise<string>((resolve) => {
    accept = resolve;
  });
  const started = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  try {
    await f.turn('turn/started', 'T1');
    f.textAcceptance(async () => {
      submitted();
      return pending;
    });
    const typed = f.call.sendText('先查Chrome', 'typed');
    await started;
    await f.voice('不用Chrome，改iPad');
    accept('T1');
    await typed;
    await f.flush();
    assert.equal(f.writes.length, 1, 'acceptance time does not change the persisted owner input order');
    assert.match(f.writes[0], /改iPad/);
  } finally {
    accept('T1');
    await f.close();
  }
});

test('speech persistence started in idle or T1 cannot attach its delayed completion to T2', async () => {
  for (const initialTurn of [undefined, 'T1']) {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      if (initialTurn) await f.turn('turn/started', initialTurn);
      f.beforePersist(async () => {
        entered();
        await pending;
      });
      const observed = f.voice('改成iPad');
      await started;
      if (initialTurn) await f.turn('turn/completed', initialTurn);
      await f.turn('turn/started', 'T2');
      release();
      await observed;
      await f.flush();
      assert.equal(f.writes.length, 0, 'epoch is captured before storage, not borrowed from the later turn');
      assert.equal(f.store.getByThread('home', 100, 'owner').length, 1, 'original speech remains stored');
    } finally {
      release();
      await f.close();
    }
  }
});

for (const laterCount of [255, 256])
  test(`currentness uses the exclusive after-source bound: ${laterCount} later rows`, async () => {
    const f = await fixture();
    try {
      await f.turn('turn/started', 'T1');
      await f.voice('改成iPad');
      for (let i = 0; i < laterCount; i++)
        f.store.append({
          userId: 'owner',
          threadId: 'home',
          from: { kind: 'agent', catId: createCatId('sonnet') },
          content: 'unrelated work',
          mentions: [],
          timestamp: Date.now(),
        });
      await f.flush();
      assert.equal(f.writes.length, laterCount < 256 ? 1 : 0);
    } finally {
      await f.close();
    }
  });
