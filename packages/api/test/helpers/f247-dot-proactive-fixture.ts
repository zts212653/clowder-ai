import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry, createCatId, type MessageWorkDisposition } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { loadCatConfig, toAllCatConfigs } from '../../src/config/cat-config-loader.js';
import { saveMessageDispositionPreference } from '../../src/config/user-preferences-store.js';
import { AgentKeyRegistry } from '../../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { MemoryCloudReturnGrantStore } from '../../src/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { DotAskService } from '../../src/domains/cats/services/cloud-bridge/dot/DotAskService.js';
import { DotConnectionService } from '../../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotDispatchStore } from '../../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotEventsBridge } from '../../src/domains/cats/services/cloud-bridge/dot/DotEventsBridge.js';
import { DotReturnService } from '../../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import type { AgentRouter } from '../../src/domains/cats/services/index.js';
import { InvocationRecordStore } from '../../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../../src/infrastructure/websocket/index.js';
import { type CallbackRoutesOptions, callbacksRoutes } from '../../src/routes/callbacks.js';
import { registerDotMcpRoutes } from '../../src/routes/chatgpt-dot-mcp-routes.js';
import { sharedRemote } from './f247-shared-remote.js';

export async function dotProactiveFixture(
  options: Pick<CallbackRoutesOptions, 'turnExecutionStore'> & { messageDisposition?: MessageWorkDisposition } = {},
) {
  for (const [id, config] of Object.entries(
    toAllCatConfigs(loadCatConfig(fileURLToPath(new URL('../../../../cat-template.json', import.meta.url)))),
  ))
    if (!catRegistry.has(id)) catRegistry.register(id, config);
  if (!catRegistry.has('gpt-dot'))
    catRegistry.register('gpt-dot', {
      ...catRegistry.getOrThrow('codex').config,
      id: createCatId('gpt-dot'),
      displayName: 'test dot',
      provider: 'openai-chatgpt-pro',
      clientId: 'openai',
      mentionPatterns: ['@dot'],
    });
  const dir = await mkdtemp(join(tmpdir(), 'dot-ask-'));
  const app = Fastify();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const keys = new AgentKeyRegistry();
  const registry = new InvocationRegistry();
  const records = new InvocationRecordStore();
  const invocationTracker = new InvocationTracker();
  if (options.messageDisposition)
    saveMessageDispositionPreference(dir, { scope: 'global', disposition: options.messageDisposition });
  const carrierCapability = {
    provider: 'openai_codex',
    carrier: 'codex_app_server',
    deliverySemantics: 'exact_active_turn',
    activeInvocationGuidance: 'supported',
  } as const;
  const queue = new InvocationQueue(undefined, {
    projectRoot: dir,
    invocationTracker,
    resolveCarrierCapability: () => carrierCapability,
  });
  const queueProcessor: NonNullable<CallbackRoutesOptions['queueProcessor']> = {};
  const postResults: Array<{ statusCode: number; body: { messageId?: string; kind?: string } }> = [];
  let enabled = true;
  const connection = new DotConnectionService({
    keys,
    store: new DotConnectionStore(join(dir, 'connection.json')),
    authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'installed' }),
    ensureIdentity: async () => {},
    sendWebhook: async (_url, _headers, body) => ({
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
    }),
  });
  const setup = await connection.begin('owner');
  const pro = await keys.issue(createCatId('gpt-pro'), 'owner');
  await connection.subscribe(setup.credentialSecret, {
    attemptId: setup.attemptId!,
    pairingCode: setup.pairingCode!,
    url: 'https://example.com/dot',
    secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
    ttlMs: null,
  });
  const asks = new DotAskService({
    connection,
    messages,
    threads,
    enabled: async () => enabled,
    post: async (secret, payload) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': secret },
        payload,
      });
      const body = r.json() as { messageId?: string; kind?: string };
      postResults.push({ statusCode: r.statusCode, body });
      if (r.statusCode !== 200 || !body.messageId)
        throw new Error(
          body.kind === 'dot_ask_idempotency_conflict' || body.kind === 'dot_ask_delivery_pending'
            ? body.kind
            : 'dot_ask_not_persisted',
        );
      return body;
    },
  });
  const dispatches = new DotDispatchStore(join(dir, 'events'));
  const events: Array<{ eventId: string; data: { source_message_id: string; thread_id: string } }> = [];
  const bridge = new DotEventsBridge({
    connection,
    dispatches,
    messageStore: messages,
    threadStore: threads,
    enabled: async () => enabled,
    sendWebhook: async (_url, _headers, body) => {
      events.push(JSON.parse(body));
      return { status: 202, body: '{}' };
    },
  });
  const returns = new DotReturnService({
    connection,
    dispatches,
    messages,
    threads,
    enabled: async () => enabled,
    postReply: async ({ threadId, sourceMessageId, content }) => ({
      messageId: messages.append({
        threadId,
        userId: 'owner',
        from: { kind: 'agent', catId: createCatId('gpt-dot') },
        replyTo: sourceMessageId,
        content,
        mentions: [],
        timestamp: Date.now(),
      }).id,
    }),
  });
  const socket = {
    broadcastAgentMessage: () => {},
    broadcastToRoom: () => {},
    emitToUser: () => {},
  } as unknown as SocketManager;
  await app.register(callbacksRoutes, {
    ...options,
    registry,
    agentKeyRegistry: keys,
    messageStore: messages,
    threadStore: threads,
    socketManager: socket,
    invocationQueue: queue,
    queueProcessor,
    invocationTracker,
    invocationRecordStore: records,
    router: {} as AgentRouter,
    admitDotReturn: (i) => returns.admitReturn(i),
    admitDotAsk: (i) => asks.admit(i),
    dotReplyTarget: (source) => asks.replyTarget(source),
    cloudReturnGrantStore: new MemoryCloudReturnGrantStore(),
  });
  registerDotMcpRoutes(app, {
    connection,
    returns,
    ask: (secret, i) => asks.ask(secret, i),
    publishImage: async () => ({}),
  });
  await app.ready();
  const remote = await sharedRemote(app, dir, pro.secret);
  const thread = (name: string, owner = 'owner') => {
    const t = threads.create(owner, name);
    threads.addParticipants(t.id, [createCatId('codex'), createCatId('sonnet')]);
    return t;
  };
  const rpc = async (args: Record<string, unknown>) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/plugins/chatgpt-dot/shared-mcp',
        headers: { 'x-agent-key-secret': pro.secret },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cat_cafe_dot_ask', arguments: args } },
      })
    ).json();
  const ask = async (threadId: string, key = 'request', content = '请回答这一问') =>
    rpc({
      attempt_id: setup.attemptId,
      thread_id: threadId,
      target_cat_ids: ['codex'],
      content,
      client_message_id: key,
    });
  const replyCredentials = new Map<string, Awaited<ReturnType<typeof registry.create>>>();
  const reply = async (
    root: string,
    t: string,
    cat = 'codex',
    explicitRoot?: string,
    explicitDot = false,
    _finalPublication = true,
  ) => {
    const key = `${root}:${cat}`;
    const auth = replyCredentials.get(key) ?? (await registry.create('owner', createCatId(cat), t, undefined, root));
    replyCredentials.set(key, auth);
    const parent = messages.getById(root);
    if (
      parent?.lifecycle?.kind === 'input' &&
      parent.extra?.dotAsk?.recipientCatIds.includes(cat) &&
      !parent.lifecycle.dispatchRefs?.some((ref) => ref.targetId === cat)
    ) {
      const response = messages.append({
        userId: 'owner',
        threadId: t,
        from: { kind: 'agent', catId: createCatId(cat) },
        content: '',
        mentions: [],
        timestamp: Date.now(),
        origin: 'stream',
        lifecycle: {
          kind: 'response',
          orderKey: `${Date.now()}:${auth.invocationId}`,
          invocationId: auth.invocationId,
          targetId: cat,
          inputEntryIds: [],
          inputMessageIds: [root],
          status: 'processing',
          startedAt: Date.now(),
        },
      });
      messages.advanceLifecycleInputDispatch(root, {
        kind: 'input',
        orderKey: parent.lifecycle.orderKey,
        targetId: cat,
        phase: 'dispatched',
        statusMessageId: response.id,
        dispatchedAt: Date.now(),
      });
    }
    const r = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        content: '真实回答',
        ...(explicitRoot ? { replyTo: explicitRoot } : {}),
        ...(explicitDot ? { targetCats: ['gpt-dot'] } : {}),
      },
    });
    assert.equal(r.statusCode, 200, r.payload);
    return messages.getById(r.json().messageId)!;
  };
  const deliver = async (id: string, invocation = 'dot-delivery') => {
    const source = messages.getById(id)!;
    return bridge.dispatch({
      catId: createCatId('gpt-dot'),
      userId: 'owner',
      threadId: source.threadId,
      sourceMessageId: id,
      dispatchInvocationId: invocation,
      content: source.content,
    });
  };
  return {
    app,
    messages,
    threads,
    keys,
    registry,
    records,
    socket,
    queue,
    queueProcessor,
    invocationTracker,
    connection,
    carrierCapability,
    setup,
    pro,
    asks,
    postResults,
    bridge,
    events,
    returns,
    thread,
    ask,
    rpc,
    reply,
    deliver,
    remote,
    disable: () => {
      enabled = false;
    },
    close: async () => {
      await remote.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
