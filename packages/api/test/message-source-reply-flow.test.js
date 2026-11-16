import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { registerCollabToolset } from '../../mcp-server/dist/server-toolsets.js';
import {
  handleCreateRichBlock,
  handleGetMessage,
  handlePostMessage,
} from '../../mcp-server/dist/tools/callback-tools.js';
import { AgentKeyRegistry } from '../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MessageSearchAnswerPublicationService } from '../dist/domains/memory/MessageSearchAnswerPublicationService.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { fixture, human } from './helpers/message-search-answer-fixture.js';

async function harness(t, agentKey, cloud = false) {
  const f = fixture(),
    registry = new InvocationRegistry(),
    agentKeyRegistry = new AgentKeyRegistry();
  const cloudReturnGrantStore = new MemoryCloudReturnGrantStore();
  const threadStore = new ThreadStore(),
    thread = threadStore.create('owner', 'Original-source reply');
  f.threads.set(thread.id, thread);
  const source = f.messages.append({
    userId: 'owner',
    threadId: thread.id,
    from: { kind: 'user', userId: 'owner' },
    content: 'Keep the original conditions; this is not final approval.',
    mentions: [],
    timestamp: Date.now(),
  });
  const question = cloud
    ? f.messages.append({
        userId: 'owner',
        threadId: thread.id,
        from: { kind: 'user', userId: 'owner' },
        content: 'What was decided?',
        mentions: [],
        timestamp: Date.now(),
      })
    : source;
  const catId = cloud ? 'gpt-pro' : 'opus';
  const auth = await registry.create('owner', catId, thread.id);
  const key = await agentKeyRegistry.issue(catId, 'owner', cloud ? { scope: 'cloud-conversation' } : undefined);
  const grantScope = { userId: 'owner', threadId: thread.id, sourceMessageId: question.id, targetCatId: catId };
  if (cloud)
    assert.equal(
      (await cloudReturnGrantStore.issue({ ...grantScope, dispatchInvocationId: 'original-dispatch' })).ok,
      true,
    );
  const service = new MessageSearchAnswerPublicationService(f.store, f.search, f.messages, threadStore);
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    agentKeyRegistry,
    cloudReturnGrantStore,
    threadStore,
    messageStore: f.messages,
    messageSearchAnswerService: service,
    messageSearchService: f.search,
    router: {},
    invocationRecordStore: {},
    invocationQueue: new InvocationQueue(),
    queueProcessor: {
      async requestDrain() {},
      async tryAutoAppendExactEntry() {
        return { outcome: 'rejected' };
      },
      registerCallerDispatchInitialTargets() {},
    },
    socketManager: { broadcastAgentMessage() {}, emitToUser() {} },
  });
  const savedEnv = { ...process.env },
    savedFetch = globalThis.fetch,
    paths = [];
  for (const name of [
    'CAT_CAFE_CREDENTIAL_FILE',
    'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
    'CAT_CAFE_AGENT_KEY_FILES',
    'CAT_CAFE_AGENT_KEY_FILE',
    'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
    'CAT_CAFE_INVOCATION_ID',
    'CAT_CAFE_CALLBACK_TOKEN',
    'CAT_CAFE_AGENT_KEY_SECRET',
    'CAT_CAFE_DESKTOP_MODE',
    'CAT_CAFE_READONLY',
    'CAT_CAFE_READONLY_AGENT_KEY_UNION',
    'CAT_CAFE_WATCHER_TOOL_NAMES',
    'CAT_CAFE_MCP_PROFILE',
  ])
    delete process.env[name];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:49153';
  if (agentKey) process.env.CAT_CAFE_AGENT_KEY_SECRET = key.secret;
  else {
    process.env.CAT_CAFE_INVOCATION_ID = auth.invocationId;
    process.env.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
  }
  // Exercise the production MCP adapters and authenticated Fastify handlers without network or Redis.
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'http://127.0.0.1:49153');
    paths.push(parsed.pathname);
    const result = await app.inject({
      method: init.method ?? 'GET',
      url: parsed.pathname + parsed.search,
      headers: init.headers,
      ...(init.body ? { payload: init.body } : {}),
    });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
  t.after(async () => {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env, savedEnv);
    await app.close();
    f.db.close();
  });
  const producer = { kind: 'invocation', id: auth.invocationId, catId: 'opus' };
  return { ...f, app, service, source, question, thread, producer, paths, auth, cloudReturnGrantStore, grantScope };
}

function resultBody(result) {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}

for (const mode of ['normal-response', 'explicit-post', 'agent-key-post']) {
  test(`${mode}: full original -> chosen quotation -> common reply -> real Host card, with correction invalidation`, async (t) => {
    const h = await harness(t, mode === 'agent-key-post');
    const original = resultBody(await handleGetMessage({ messageId: h.source.id, mode: 'full' })).message;
    assert.match(original.contentRevision, /^[a-f0-9]{64}$/);
    assert.equal(
      h.db.prepare('SELECT count(*) n FROM message_search_answer_publications').get().n,
      0,
      'reading an original must never prepare a card',
    );
    const selections = [
      {
        threadId: original.threadId,
        messageId: original.id,
        contentRevision: original.contentRevision,
        quote: original.content,
        reason: 'The original explicitly withholds final approval.',
        part: original.sourceParts[0].part,
      },
    ];
    const block = JSON.stringify({
      kind: 'sources',
      v: 1,
      id: 'reply-purpose',
      query: 'What was decided?',
      selections,
    });
    let messageId;
    if (mode === 'normal-response') {
      const prepared = resultBody(await handleCreateRichBlock({ block }));
      assert.equal(prepared.status, 'prepared');
      assert.equal(h.store.get(prepared.publicationRef).bound_message_id, null);
      const message = h.messages.append({
        userId: 'owner',
        threadId: h.thread.id,
        from: { kind: 'agent', catId: 'opus' },
        content: 'The conditions remain.',
        mentions: [],
        timestamp: Date.now(),
        origin: 'stream',
        idempotencyKey: `message-lifecycle-response:${h.producer.id}`,
        lifecycle: {
          kind: 'response',
          invocationId: h.producer.id,
          targetId: 'opus',
          status: 'completed',
          orderKey: 'reply',
          inputEntryIds: [],
          inputMessageIds: [h.source.id],
          startedAt: Date.now(),
          completedAt: Date.now(),
        },
      });
      await h.service.publishResponse(message, h.producer.id);
      messageId = message.id;
      assert.equal(h.paths.filter((path) => path.endsWith('/post-message')).length, 0);
    } else {
      const send = () =>
        handlePostMessage({
          content: 'The conditions remain.',
          clientMessageId: 'reply-purpose',
          searchAnswer: { query: 'What was decided?', selections },
          ...(mode === 'agent-key-post' ? { threadId: h.thread.id } : {}),
        });
      messageId = resultBody(await send()).messageId;
      assert.equal(resultBody(await send()).messageId, messageId, 'retry recovers the same actual reply');
    }
    const stored = h.messages.getById(messageId),
      binding = stored.extra.messageSearchAnswer;
    assert.ok(binding);
    assert.equal(
      stored.content,
      'The conditions remain.',
      'the card must bind to the actual answer, never its query label',
    );
    assert.equal(stored.extra.rich.blocks.filter((block) => block.meta?.domain === 'message-search-answer').length, 1);
    const card = await h.service.read(messageId, binding.blockId, human);
    assert.equal(card.status, 'available');
    assert.equal(card.response.results[0].selection.quote, original.content);
    assert.equal(card.response.results[0].messageId, h.source.id);
    assert.equal(h.searches(), 0);
    assert.equal(h.calls(), 0, 'no retired generative judge');
    h.messages.getById(h.source.id).content = 'Corrected original.';
    assert.notEqual((await h.service.read(messageId, binding.blockId, human)).status, 'available');
  });
}

test('full thread-context supplies the same original revision; previews and oversized anchors do not claim a full read', async (t) => {
  const h = await harness(t, false);
  const read = async (mode) => {
    const result = await h.app.inject({
      url: `/api/callbacks/thread-context?responseMode=${mode}`,
      headers: { 'x-invocation-id': h.auth.invocationId, 'x-callback-token': h.auth.callbackToken },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().messages.find((row) => row.id === h.source.id);
  };
  const original = resultBody(await handleGetMessage({ messageId: h.source.id, mode: 'full' })).message;
  const full = await read('full');
  assert.equal(full.contentRevision, original.contentRevision);
  assert.deepEqual(full.sourceParts, original.sourceParts);
  assert.equal((await read('anchor')).contentRevision, undefined);
  h.messages.getById(h.source.id).content = 'x'.repeat(100000);
  const oversized = await read('full');
  assert.equal(oversized.oversized, true);
  assert.equal(oversized.contentRevision, undefined);
});

for (const profile of ['full', 'cloud-pro-phase0']) {
  test(`registered ${profile} agent-key reply keeps the actual answer, card and single return grant together`, async (t) => {
    const h = await harness(t, true, true);
    if (profile === 'cloud-pro-phase0') {
      process.env.CAT_CAFE_DESKTOP_MODE = profile;
      process.env.CAT_CAFE_READONLY = 'true';
    }
    const server = new McpServer({ name: 'source-reply-contract', version: '1' });
    registerCollabToolset(server);
    const client = new Client({ name: 'source-reply-consumer', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
      await client.close();
      await server.close();
    });
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((tool) => tool.name === 'cat_cafe_create_rich_block'),
      profile === 'full',
    );
    const original = resultBody(
      await client.callTool({ name: 'cat_cafe_get_message', arguments: { messageId: h.source.id, mode: 'full' } }),
    ).message;
    const searchAnswer = {
      query: 'What was decided?',
      selections: [
        {
          threadId: original.threadId,
          messageId: original.id,
          contentRevision: original.contentRevision,
          quote: original.content,
          reason: 'The source preserves the conditions.',
        },
      ],
    };
    const replies = () => h.messages.getByThread(h.thread.id).filter((message) => message.from?.kind === 'agent');
    if (profile === 'full') {
      const rejected = await client.callTool({
        name: 'cat_cafe_create_rich_block',
        arguments: {
          threadId: h.thread.id,
          block: JSON.stringify({
            kind: 'sources',
            v: 1,
            id: 'reply-purpose',
            ...searchAnswer,
            replyTo: h.question.id,
          }),
        },
      });
      assert.equal(
        replies().length,
        0,
        `source-card input alone must not send a query as the answer: ${JSON.stringify(replies().map((message) => message.content))}`,
      );
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /post_message/);
    }
    const request = {
      threadId: h.thread.id,
      replyTo: h.question.id,
      clientMessageId: 'actual-answer',
      content: 'Only merge after review.',
      searchAnswer,
    };
    const noGrant = await client.callTool({
      name: 'cat_cafe_post_message',
      arguments: { ...request, replyTo: 'not-granted' },
    });
    assert.equal(noGrant.isError, true);
    assert.equal(replies().length, 0);
    assert.equal(h.db.prepare('SELECT count(*) n FROM message_search_answer_publications').get().n, 0);
    const stillPending = await h.cloudReturnGrantStore.claim(h.grantScope);
    assert.equal(stillPending.ok, true, 'neither a rejected rich call nor an incorrect return may consume the grant');
    assert.equal(await h.cloudReturnGrantStore.release(stillPending), true);
    const posted = resultBody(await client.callTool({ name: 'cat_cafe_post_message', arguments: request }));
    const retried = resultBody(await client.callTool({ name: 'cat_cafe_post_message', arguments: request }));
    assert.equal(retried.messageId, posted.messageId);
    assert.equal(replies().length, 1);
    const answer = replies()[0];
    assert.equal(answer.content, request.content);
    assert.equal(answer.id, posted.messageId);
    const binding = answer.extra.messageSearchAnswer;
    assert.ok(binding);
    assert.equal((await h.service.read(answer.id, binding.blockId, human)).status, 'available');
    assert.deepEqual(await h.cloudReturnGrantStore.claim(h.grantScope), { ok: false, reason: 'consumed' });
    assert.equal(h.searches(), 0);
    assert.equal(h.calls(), 0);
  });
}
