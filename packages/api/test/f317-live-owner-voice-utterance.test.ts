import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore, type StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../src/domains/concierge/live/LiveCompanionCall.js';
import { voiceEnvelope } from './helpers/f317-ns-reg-live.js';

async function fixture(prior = 0) {
  const store = new MessageStore();
  for (let i = 0; i < prior; i++)
    store.append({
      userId: 'owner',
      threadId: 'home',
      from: i % 2 ? { kind: 'agent', catId: createCatId('codex61-sol') } : { kind: 'user', userId: 'owner' },
      content: 'earlier conversation',
      mentions: [],
      timestamp: Date.now() - 10_000 + i,
    });
  const writes: { text: string; refs: readonly string[] }[] = [];
  let beforeWrite = async () => {};
  let beforePersist = async (_content: string) => {};
  let beforeSourceRead = async (_id: string) => {};
  let replacement: StoredMessage | undefined;
  const call = await LiveCompanionCall.create({
    binding: { userId: 'owner', threadId: 'home', catId: createCatId('codex61-sol'), callId: 'call' },
    householdToolsEnabled: false,
    messageStore: {
      recordCompanionDeliveryAcceptance: (...args) => store.recordCompanionDeliveryAcceptance(...args),
      appendIdempotent: async (row) => {
        await beforePersist(row.content);
        return store.appendIdempotent(row);
      },
      getById: async (id) => {
        await beforeSourceRead(id);
        return replacement?.id === id ? replacement : store.getById(id);
      },
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
  await call.ready('native', {
    submitText: async () => 'text-accepted',
    submitContextAtBoundary: async (text, refs, _kind, signal, authorize) => {
      await beforeWrite();
      if (signal.aborted || !(await authorize())) throw new Error('source superseded');
      writes.push({ text, refs });
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
      if (method === 'turn/interrupt')
        await call.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'active' } } });
      return {};
    },
  });
  await call.start('offer');
  await call.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'active' } } });
  return {
    call,
    store,
    writes,
    begin: () =>
      call.observe({
        method: 'thread/realtime/transcript/delta',
        params: { threadId: 'native', role: 'user', delta: '不' },
      }),
    segment: (id: string, text: string, session = 'rtc') =>
      call.observe(voiceEnvelope(session, 'user', id, text, 'native')),
    done: (text: string) =>
      call.observe({ method: 'thread/realtime/transcript/done', params: { threadId: 'native', role: 'user', text } }),
    flush: () => call.onSafeBoundary('tool_complete'),
    rows: () => store.getByThread('home', 100, 'owner'),
    replaceBeforeWrite: (row: StoredMessage) => {
      beforeWrite = async () => {
        replacement = row;
      };
    },
    beforeWrite: (operation: () => Promise<void>) => {
      beforeWrite = operation;
    },
    beforePersist: (operation: (content: string) => Promise<void>) => {
      beforePersist = operation;
    },
    beforeSourceRead: (operation: (id: string) => Promise<void>) => {
      beforeSourceRead = operation;
    },
  };
}

test('an earlier segment can persist after the suffix without losing the complete utterance', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let prefix: Promise<void> | undefined;
  try {
    await f.begin();
    f.beforePersist(async (content) => {
      if (content === '不用') {
        entered();
        await pending;
      }
    });
    prefix = f.segment('prefix', '不用');
    await started;
    await f.segment('suffix', 'Chrome');
    await f.done('不用Chrome');
    await f.flush();
    assert.equal(f.writes.length, 0, 'the incomplete durable source is not injected');
    release();
    await prefix;
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].text, /不用Chrome/);
    assert.equal(f.writes[0].refs.length, 2);
  } finally {
    release();
    await prefix;
    await f.call.stop();
  }
});

for (const prior of [254, 300])
  for (const split of [false, true])
    test(`a current ${split ? 'split' : 'single'} utterance survives ${prior} earlier messages`, async () => {
      const f = await fixture(prior);
      try {
        await f.begin();
        if (split) {
          await f.segment('a', '不用');
          await f.segment('b', 'Chrome');
        } else await f.segment('a', '不用Chrome');
        await f.done('不用Chrome');
        await f.flush();
        assert.equal(f.writes.length, 1);
        assert.match(f.writes[0].text, /不用Chrome/);
      } finally {
        await f.call.stop();
      }
    });

test('r5: complete native utterance retains a separately committed cancellation prefix and both sources', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('prefix', '不用');
    await f.segment('suffix', ' Chrome 了,改用 iPad 外放,不需要接任何东西');
    await f.done('不用 Chrome 了,改用 iPad 外放,不需要接任何东西');
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].text, /不用 Chrome 了,改用 iPad/);
    assert.deepEqual(
      f.writes[0].refs,
      f.rows().map((row) => `home#${row.id}`),
    );
    assert.deepEqual(
      f.rows().map((row) => row.content),
      ['不用', ' Chrome 了,改用 iPad 外放,不需要接任何东西'],
    );
  } finally {
    await f.call.stop();
  }
});

test('new utterance does not include a previous iPad proposal', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('old', '改用iPad');
    await f.done('改用iPad');
    await f.begin();
    await f.segment('new', '还是Chrome');
    await f.done('还是Chrome');
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.doesNotMatch(f.writes[0].text, /改用iPad/);
    assert.match(f.writes[0].text, /还是Chrome/);
  } finally {
    await f.call.stop();
  }
});

test('native done whitespace differences do not lose source-linked words', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('a', 'Chrome声音的入口');
    await f.done('Chrome 声音的 入口');
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].text, /Chrome声音的入口/);
  } finally {
    await f.call.stop();
  }
});

test('a typed correction supersedes the complete queued utterance', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('a', '不用');
    await f.segment('b', 'Chrome');
    await f.done('不用Chrome');
    await f.call.sendText('还是Chrome', 'typed-correction');
    await f.flush();
    assert.deepEqual(f.writes, []);
  } finally {
    await f.call.stop();
  }
});

test('late segments from an interrupted utterance cannot supersede a typed correction', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('prefix', '不用');
    await f.call.sendText('还是Chrome', 'typed-correction');
    await f.segment('suffix', 'Chrome');
    await f.done('不用Chrome');
    await f.flush();
    assert.deepEqual(f.writes, [], 'a suffix of pre-correction speech is not a new owner choice');
    await f.begin();
    await f.segment('new-choice', '改用Chrome');
    await f.done('改用Chrome');
    await f.flush();
    assert.equal(f.writes.length, 1, 'the next actual utterance still enters the original active turn');
    assert.match(f.writes[0].text, /改用Chrome/);
  } finally {
    await f.call.stop();
  }
});

test('last native write revalidates the earlier cancellation source as well as the latest suffix', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('a', '不用');
    await f.segment('b', 'Chrome');
    await f.done('不用Chrome');
    f.replaceBeforeWrite({ ...f.rows()[0], content: '需要' });
    await f.flush();
    assert.deepEqual(f.writes, []);
  } finally {
    await f.call.stop();
  }
});

test('owner currentness is rechecked after the asynchronous reads of all utterance parts', async () => {
  const f = await fixture();
  try {
    await f.begin();
    await f.segment('a', '不用');
    await f.segment('b', 'Chrome');
    await f.done('不用Chrome');
    const prefix = f.rows()[0].id;
    let finalWrite = false;
    let corrected = false;
    f.beforeWrite(async () => {
      finalWrite = true;
    });
    f.beforeSourceRead(async (id) => {
      if (!finalWrite || corrected || id !== prefix) return;
      corrected = true;
      f.store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: '还是Chrome',
        mentions: [],
        timestamp: Date.now(),
      });
    });
    await f.flush();
    assert.equal(corrected, true);
    assert.deepEqual(f.writes, []);
  } finally {
    await f.call.stop();
  }
});

for (const mode of ['mismatched-complete-text', 'foreign-prefix', 'unbounded-segments'] as const)
  test(`utterance source is rejected for ${mode}`, async () => {
    const f = await fixture();
    try {
      await f.begin();
      if (mode === 'unbounded-segments') {
        for (let i = 0; i < 33; i++) await f.segment(`part-${i}`, '字');
        await f.done('字'.repeat(33));
      } else {
        await f.segment('a', '不用', mode === 'foreign-prefix' ? 'foreign' : 'rtc');
        await f.segment('b', 'Chrome');
        await f.done(mode === 'mismatched-complete-text' ? '需要Chrome' : '不用Chrome');
      }
      await f.flush();
      assert.deepEqual(f.writes, []);
    } finally {
      await f.call.stop();
    }
  });
