import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '@cat-cafe/mcp-server/dist/canonical-server-tools.js';
import Fastify from 'fastify';
import { watcherToolSurface } from '../dist/domains/concierge/watcher/watcher-surface.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { registerSuggestionRoutes } from '../dist/routes/suggestion-routes.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

const TOOL = 'cat_cafe_bring_to_desk';
const WORK = { contentRef: 'work:watcher-desk-fixture', ownerRevision: 3 };

async function publishedWork(w) {
  return w.messages.append({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    from: { kind: 'agent', catId: 'codex' },
    content: '第三版已经做好。',
    timestamp: Date.now(),
    mentions: [],
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            id: 'published-work-card',
            kind: 'card',
            v: 1,
            title: '已发布的第三版作品',
            bodyMarkdown: '已保存并挂卡的第三版。',
            meta: { kind: 'work_reference', reference: WORK },
          },
        ],
      },
    },
  });
}

function deskRoutes(app, w, quiet, operations) {
  const integration = createSuggestionIntegration({ messageStore: w.messages });
  app.register(async (scope) =>
    registerSuggestionRoutes(scope, {
      ...integration,
      callbackRegistry: w.registry,
      resolveByline: async () => 'watcher',
      authorizeActor: async (_actor, operation) => {
        operations.push(operation);
        return operation === 'facts' || !quiet();
      },
    }),
  );
  return integration;
}

test('the watcher advertises the canonical desk tool with its exact callback and unchanged six-call budget', () => {
  const surface = watcherToolSurface({});
  const tool = surface.tools.find((entry) => entry.name === TOOL);
  assert.ok(tool, 'the native model must see the existing desk tool');
  assert.equal(
    tool,
    CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === TOOL),
  );
  assert.ok(surface.policy.allowedToolNames.includes(TOOL));
  assert.ok(surface.policy.allowedCallbackRoutes.includes('POST /api/callbacks/desk-deliveries'));
  assert.equal(surface.policy.maxToolCalls, 6);
  assert.ok(!surface.policy.allowedToolNames.includes('cat_cafe_work'), 'this does not grant a new work writer');
});

test('desk callbacks require the bound watcher ticket; replay, quiet refusal and read-only facts keep their contracts', async (t) => {
  const w = await watcherWorld();
  const card = await publishedWork(w);
  const app = Fastify();
  t.after(() => app.close());
  let quiet = false;
  const operations = [];
  const integration = deskRoutes(app, w, () => quiet, operations);
  const auth = await w.registry.create(
    'watcher-owner',
    'codex',
    w.thread.id,
    undefined,
    undefined,
    watcherToolSurface({}).policy,
  );
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const payload = { messageId: card.id, sentence: '这版已做好，带给你看看。', work: WORK };
  const deliver = (callId, body = payload) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/desk-deliveries',
      headers: { ...headers, 'x-watcher-tool-call-id': callId },
      payload: body,
    });
  await w.registry.consumeWatcherToolCall(auth.invocationId, 'read', 'cat_cafe_suggestion_facts');
  assert.equal((await deliver('read')).statusCode, 403, 'a facts ticket cannot write');
  assert.equal(await w.registry.consumeWatcherToolCall(auth.invocationId, 'bring', TOOL), 'accepted');
  const brought = await deliver('bring');
  assert.equal(brought.statusCode, 200, brought.body);
  assert.equal(brought.json().status, 'ready');
  const replay = await deliver('bring');
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), brought.json());
  assert.deepEqual(operations, ['bring'], 'HTTP replay never creates another desk record');
  assert.equal((await deliver('bring', { ...payload, sentence: '另一个请求。' })).statusCode, 403);
  assert.equal((await integration.desk.next('watcher-owner', { returning: false })).items.length, 1);
  quiet = true;
  await w.registry.consumeWatcherToolCall(auth.invocationId, 'quiet', TOOL);
  const denied = await deliver('quiet');
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().code, 'watcher_quiet');
  const facts = await app.inject({
    method: 'POST',
    url: '/api/callbacks/suggestion-facts',
    headers: { ...headers, 'x-watcher-tool-call-id': 'read' },
    payload: { kind: 'brought-work' },
  });
  assert.equal(facts.statusCode, 200, facts.body);
  assert.deepEqual(operations, ['bring', 'bring', 'facts']);
  for (let n = 0; n < 3; n++)
    assert.equal(await w.registry.consumeWatcherToolCall(auth.invocationId, `rest-${n}`, TOOL), 'accepted');
  assert.equal(await w.registry.consumeWatcherToolCall(auth.invocationId, 'seventh', TOOL), 'exhausted');
  assert.equal((await integration.desk.next('watcher-owner', { returning: false })).items.length, 1);
});

for (const quiet of [false, true]) {
  test(
    `the native watcher ${quiet ? 'denies desk speech before HTTP while retaining facts' : 'uses the canonical desk handler for an already published work'}`,
    {
      timeout: 35000,
      skip: !nativeWatcherAvailable,
    },
    async () => {
      const w = await watcherWorld();
      const card = await publishedWork(w);
      const operations = [];
      let integration;
      const f = await watcherNativeFixture(w, {
        configure: async ({ app, state }) => {
          integration = deskRoutes(app, w, () => state.quiet, operations);
        },
      });
      try {
        f.state.quiet = quiet;
        const [source] = await w.work('RAW_INCREMENT_31');
        f.state.toolPlan = [
          { name: TOOL, args: { messageId: card.id, sentence: '这版已做好，带给你看看。', work: WORK } },
        ];
        if (quiet) f.state.toolPlan.push({ name: 'cat_cafe_suggestion_facts', args: { kind: 'brought-work' } });
        const session = await f.run(source, AbortSignal.timeout(30000));
        assert.equal(session.watcherState.afterSequence, source.settledSequence);
        assert.ok(f.requests[0].body.tools.some((tool) => tool.name === TOOL));
        const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
        assert.equal(await w.registry.watcherToolCallCount(wake.invocationId), quiet ? 2 : 1);
        const results = JSON.stringify(
          f.requests.at(-1).body.input.filter((item) => item.type === 'function_call_output'),
        );
        if (quiet) {
          assert.match(results, /Watcher is quiet/);
          assert.deepEqual(operations, ['facts'], 'quiet speech must be stopped by the native bridge before callback');
          assert.equal(await integration.desk.next('watcher-owner', { returning: false }), null);
        } else {
          assert.match(results, /ready/);
          assert.deepEqual(operations, ['bring']);
          const delivery = await integration.desk.next('watcher-owner', { returning: false });
          assert.equal(delivery.items.length, 1);
          assert.equal(delivery.items[0].threadId, w.thread.id);
          assert.equal(delivery.items[0].byline, 'watcher');
          assert.deepEqual(delivery.items[0].work, WORK);
          const opened = await integration.desk.settle('watcher-owner', {
            action: 'open',
            items: [{ ref: delivery.items[0].ref, revision: delivery.items[0].revision }],
          });
          assert.deepEqual(opened.open, { threadId: w.thread.id, messageId: card.id, work: WORK });
        }
      } finally {
        await f.close();
      }
    },
  );
}
