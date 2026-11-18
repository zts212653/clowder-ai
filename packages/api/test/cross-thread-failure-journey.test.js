import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';

for (const mode of ['prestart', 'response']) {
  test(`real cross-post ${mode} failure → origin caller reads the cause with its own credentials`, async (t) => {
    const f = await queueHttpFixture(t);
    // The routing journey needs a workspace identity, not the developer checkout's Git daemon.
    const projectPath = await mkdtemp(join(tmpdir(), 'cross-thread-failure-journey-'));
    t.after(() => rm(projectPath, { recursive: true, force: true }));
    const origin = await f.threads.create('owner', 'the actual dispatching caller', projectPath);
    const received = [];
    f.agents.get('codex').invoke = async function* (prompt, options) {
      const coordinate = prompt.match(/失败结果：(\S+)#(\S+)/);
      assert.ok(coordinate, 'caller can locate the exact failure using the control input');
      const query = new URLSearchParams({
        threadId: coordinate[1],
        messageId: coordinate[2],
        before: '0',
        after: '0',
        responseMode: 'full',
      });
      const env = options.callbackEnv;
      assert.equal(env.CAT_CAFE_THREAD_ID, origin.id, 'read uses the newly invoked origin cat identity');
      assert.notEqual(env.CAT_CAFE_INVOCATION_ID, sourceAuth.invocationId);
      const read = await f.app.inject({
        method: 'GET',
        url: `/api/callbacks/thread-context?${query}`,
        headers: {
          'x-invocation-id': env.CAT_CAFE_INVOCATION_ID,
          'x-callback-token': env.CAT_CAFE_CALLBACK_TOKEN,
        },
      });
      assert.equal(read.statusCode, 200, read.body);
      const failure = read.json().messages.find((message) => message.id === coordinate[2]);
      assert.ok(failure, 'origin credentials can read the target failure, not just its coordinate');
      const cause = mode === 'prestart' ? /接收对象当前无效|执行绑定无法通过准入/ : /provider network unavailable/;
      assert.match(failure.content, cause);
      assert.doesNotMatch(prompt, /失败原因：/);
      assert.equal(
        prompt.includes(failure.content),
        false,
        'the caller reads the canonical body instead of receiving a copy',
      );
      assert.match(prompt, /cat_cafe_get_thread_context/);
      assert.ok(prompt.includes(`threadId="${coordinate[1]}"`));
      assert.ok(prompt.includes(`messageId="${coordinate[2]}"`));
      const unauthenticated = await f.app.inject({ method: 'GET', url: `/api/callbacks/thread-context?${query}` });
      assert.equal(unauthenticated.statusCode, 401, 'failure coordinate grants no anonymous access');
      received.push({ prompt, failureContent: failure.content });
      yield { type: 'text', catId: 'codex', content: '收到派活失败，回来源线程处理。', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    };
    const registry = f.registry;
    const records = new InvocationRecordStore();
    const sockets = { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} };
    const processor = new QueueProcessor({
      queue: f.queue,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore: records,
      messageStore: f.messages,
      threadStore: f.threads,
      router: f.router,
      socketManager: sockets,
      log: { info() {}, warn() {}, error() {} },
    });
    await f.app.register(callbacksRoutes, {
      registry,
      messageStore: f.messages,
      threadStore: f.threads,
      socketManager: sockets,
      router: f.router,
      invocationRecordStore: records,
      invocationQueue: f.queue,
      queueProcessor: processor,
    });
    const sourceAuth = await registry.create('owner', 'codex', origin.id);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': sourceAuth.invocationId, 'x-callback-token': sourceAuth.callbackToken },
      payload: { threadId: f.thread.id, content: '@gemini\n请处理这个跨线程任务。' },
    });
    assert.equal(response.statusCode, 200, response.body);
    if (mode === 'prestart') {
      f.agents.markUnavailable('gemini', { code: 'rejected-account-binding', message: 'network is offline' });
    } else {
      f.agents.get('gemini').invoke = async function* () {
        yield {
          type: 'error',
          catId: 'gemini',
          content: 'provider network unavailable',
          error: 'provider network unavailable',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
      };
    }
    f.router.refreshFromRegistry(f.agents);
    let completeTarget;
    const targetComplete = new Promise((resolve) => {
      completeTarget = resolve;
    });
    const [targetEntry] = f.queue.list(f.thread.id, 'owner');
    processor.registerEntryCompleteHook(targetEntry.id, () => completeTarget(), 'gemini');
    await processor.requestDrain(f.thread.id);
    if (mode === 'response') await targetComplete;
    assert.equal(f.queue.list(f.thread.id, 'owner').length, 0, 'destination must not schedule its own codex');
    const [wake] = f.queue.list(origin.id, 'owner');
    assert.ok(wake, 'ordinary callback failure has an origin return');
    assert.deepEqual(wake.targets, ['codex']);
    assert.match(wake.payload.content, /失败结果/);
    assert.doesNotMatch(
      wake.payload.content,
      /失败原因：/,
      'control notification carries references rather than a failure-body preview',
    );
    assert.match(wake.payload.content, /cat_cafe_get_thread_context/);
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('origin caller did not finish')), 10_000);
      t.after(() => clearTimeout(timer));
      processor.registerEntryCompleteHook(
        wake.id,
        (_id, status) => {
          clearTimeout(timer);
          resolve(status);
        },
        'codex',
      );
    });
    await processor.requestDrain(origin.id);
    assert.equal(await completion, 'succeeded');
    assert.equal(received.length, 1, 'only the actual dispatching caller runs');
    assert.match(received[0].prompt, /跨线程派活失败/);
    assert.match(received[0].prompt, new RegExp(f.thread.id));
    assert.equal(f.queue.list(origin.id, 'owner').length, 0, 'the source caller consumes its exact control carrier');
    const targetResponses = f.messages.getByThread(f.thread.id).filter((message) => message.from?.catId === 'codex');
    assert.equal(targetResponses.length, 1, 'only the original cross-post exists; no local same-name reply');
  });
}
