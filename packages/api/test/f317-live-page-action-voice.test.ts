import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, issueFixtureApproval, startedActionCall } from './helpers/f317-page-action-fixture.js';

const phrase = '把今日便签改成待伞';
const committed = (id: string, role = 'user', session = 'rtc', native = 'native') => ({
  method: 'thread/realtime/item/completed',
  params: {
    threadId: native,
    item: { id, realtimeSessionId: session, type: 'transcriptSegment', role, text: phrase },
  },
});

test('committed same-call ASR is a current request, but only a fresh owner approval permits an effect', async () => {
  const f = fixture();
  const { call, approvalLedger } = await startedActionCall(f);
  try {
    await call.observe({
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'native', role: 'user', delta: phrase },
    });
    assert.equal(await call.boundaryContexts.inspectPageActionRequest(f.source.id), null);
    await call.observe(committed('spoken-request'));
    await call.observe({
      method: 'thread/realtime/transcript/done',
      params: { threadId: 'native', role: 'user', text: phrase },
    });
    const source = f.store.getByThread('home', 20, 'owner').find((m) => m.content === phrase);
    assert.ok(source);
    const preview = await call.boundaryContexts.inspectPageActionRequest(source.id);
    assert.equal(preview?.request.text, phrase, 'the actual ASR homophone must remain unchanged');
    assert.equal(preview.request.sourceRef, `home#${source.id}`);
    assert.equal(f.effects(), 0, 'a spoken request is not action approval');
    await assert.rejects(
      call.boundaryContexts.runPageAction({
        requestMessageId: source.id,
        approval: f.approval,
        port: f.port,
        selector: f.selector,
      }),
      /approval unavailable/,
    );
    const approval = { ...f.approval, approvalId: 'owner-confirmed-spoken-request' };
    await issueFixtureApproval(approvalLedger, f, source, approval);
    const result = await call.boundaryContexts.runPageAction({
      requestMessageId: source.id,
      approval,
      port: f.port,
      selector: f.selector,
    });
    assert.equal(result.status, 'applied');
    assert.equal(f.effects(), 1);
  } finally {
    await call.stop();
  }
});

test('foreign sessions, assistant text, and renderer-copied voice metadata do not admit an owner request', async () => {
  for (const [role, session, native] of [
    ['user', 'foreign', 'native'],
    ['user', 'rtc', 'foreign'],
    ['assistant', 'rtc', 'native'],
  ]) {
    const f = fixture();
    const { call } = await startedActionCall(f);
    try {
      await call.observe(committed('not-owner-input', role, session, native));
      const source = f.store.getByThread('home', 20, 'owner').find((m) => m.content === phrase);
      if (source) assert.equal(await call.boundaryContexts.inspectPageActionRequest(source.id), null);
      const forged = f.store.append({
        userId: 'owner',
        threadId: 'home',
        from: { kind: 'user', userId: 'owner' },
        content: phrase,
        mentions: [],
        timestamp: Date.now(),
        extra: {
          liveCompanion: {
            callId: call.id,
            modality: 'voice',
            role: 'user',
            nativeThreadId: 'native',
            realtimeSessionId: 'rtc',
            nativeItemId: 'copied',
          },
        },
      });
      assert.equal(await call.boundaryContexts.inspectPageActionRequest(forged.id), null);
      assert.equal(f.effects(), 0);
    } finally {
      await call.stop();
    }
  }
});

test('replayed committed ASR and a new speech interruption cannot revive the old source', async () => {
  const f = fixture();
  const { call } = await startedActionCall(f);
  try {
    await call.observe(committed('once'));
    await call.observe({
      method: 'thread/realtime/transcript/done',
      params: { threadId: 'native', role: 'user', text: phrase },
    });
    const source = f.store.getByThread('home', 20, 'owner').find((m) => m.content === phrase);
    assert.ok(source);
    assert.ok(await call.boundaryContexts.inspectPageActionRequest(source.id));
    await call.observe(committed('once'));
    await call.observe({
      method: 'thread/realtime/transcript/done',
      params: { threadId: 'native', role: 'user', text: phrase },
    });
    assert.equal(await call.boundaryContexts.inspectPageActionRequest(source.id), null);
    await call.observe({
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'native', role: 'user', delta: '取消' },
    });
    assert.equal(await call.boundaryContexts.inspectPageActionRequest(source.id), null);
    assert.equal(f.effects(), 0);
  } finally {
    await call.stop();
  }
});

test('a durable ASR commit finishing after the next speech began cannot acquire its newer epoch', async (t) => {
  const f = fixture();
  const { call } = await startedActionCall(f);
  const append = f.store.appendIdempotent.bind(f.store);
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.store, 'appendIdempotent', async (input) => {
    await wait;
    return append(input);
  });
  try {
    const committing = call.observe(committed('delayed'));
    await call.observe({
      method: 'thread/realtime/transcript/done',
      params: { threadId: 'native', role: 'user', text: phrase },
    });
    await call.observe({
      method: 'thread/realtime/transcript/delta',
      params: { threadId: 'native', role: 'user', delta: '取消' },
    });
    release();
    await committing;
    await call.observe({
      method: 'thread/realtime/transcript/done',
      params: { threadId: 'native', role: 'user', text: '取消' },
    });
    const source = f.store.getByThread('home', 20, 'owner').find((m) => m.content === phrase);
    assert.ok(source);
    assert.equal(await call.boundaryContexts.inspectPageActionRequest(source.id), null);
    assert.equal(f.effects(), 0);
  } finally {
    release();
    await call.stop();
  }
});
