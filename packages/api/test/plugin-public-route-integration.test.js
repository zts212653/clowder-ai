import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallbackAuthTurnExecutionLifecycle } from '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

async function fixture({ fail = false, silent = false } = {}) {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const registry = new InvocationRegistry();
  const turns = new InMemoryTurnExecutionStore();
  const tracker = new InvocationTracker();
  const source = store.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'plugin', instanceId: 'instance' },
    content: 'public source only',
    mentions: ['codex'],
    timestamp: 1000,
    extra: {
      pluginMessage: {
        instanceId: 'instance',
        revision: 1,
        presentation: { connector: 'fixture', label: 'Fixture', icon: 'message' },
        provenance: { origin: { kind: 'plugin', instanceId: 'instance' }, epistemicStatus: 'observation' },
        elements: [{ elementId: 'body', kind: 'text', payload: { text: 'public source only' } }],
        appendOps: [],
      },
    },
  });
  const carrier = {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: source.id,
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'codex',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  };
  const admission = await queue.enqueueExistingMessageDurable(store, source.id, {
    userId: 'owner',
    threadId: 'thread',
    from: source.from,
    sourceId: source.id,
    messageId: source.id,
    kind: 'conversation_input',
    content: source.content,
    targetCats: ['codex'],
    intent: 'execute',
    ownerAuthProvenance: 'unknown',
    autoExecute: true,
    pluginPublicInvocation: carrier,
  });
  const state = { starts: 0, prepares: 0, disposals: 0, ownerReads: [], errors: [] };
  const agents = new AgentRegistry();
  agents.register('codex', {
    supportsToolExecutionPolicy: () => true,
    async *invoke(prompt, options) {
      state.starts++;
      state.prompt = prompt;
      state.options = options;
      if (!silent) yield { type: 'text', catId: 'codex', content: 'Host execution note', timestamp: 2000 };
      yield fail
        ? { type: 'error', catId: 'codex', error: 'provider failure', timestamp: 2001 }
        : { type: 'done', catId: 'codex', timestamp: 2001 };
    },
  });
  const execution = {
    async prepare(input) {
      state.prepares++;
      state.childId = input.invocationId;
      const ref = store.getById(source.id).lifecycle.dispatchRefs.find((r) => r.targetId === 'codex');
      assert.ok(ref, 'main lifecycle must bind the receiver before plugin preparation');
      const response = store.getById(ref.statusMessageId);
      assert.equal(response.lifecycle.invocationId, input.invocationId);
      return {
        source: { messageId: source.id, content: source.content },
        launch: {
          server: { name: 'native', command: '/fixture/no-process', args: [], env: {}, transport: 'stdio' },
          sandbox: { kind: 'public', workspaceRoot: '/fixture/public-workspace' },
          async assertCurrent() {
            input.signal.throwIfAborted();
          },
        },
        dispose() {
          state.disposals++;
        },
      };
    },
  };
  const forbidden = (name) => () => {
    state.ownerReads.push(name);
    throw Error('owner_context_read');
  };
  const router = new AgentRouter({
    agentRegistry: agents,
    registry,
    messageStore: store,
    sessionStore: {},
    turnExecutionStore: new CallbackAuthTurnExecutionLifecycle(turns, registry),
    threadStore: { get: forbidden('history'), updateLastActive: forbidden('update') },
  });
  const processor = new QueueProcessor({
    queue,
    messageStore: store,
    invocationTracker: tracker,
    invocationRecordStore: new InvocationRecordStore(),
    turnExecutionStore: turns,
    publicInvocationExecution: execution,
    router: {
      resolveConversationTargetsAtAdmission: async (targets) => [...targets],
      resolveExplicitTargets: async (targets) => [...targets],
      resolveTargetsAndIntent: async () => ({ targetCats: ['codex'], intent: { intent: 'execute' } }),
      routeExecution: (...args) => router.routeExecution(...args),
      ackCollectedCursors: async () => {},
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    log: {
      info() {},
      warn() {},
      error(...args) {
        state.errors.push(args);
      },
    },
  });
  return { store, queue, registry, turns, source, state, processor, admission };
}
async function run(f) {
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const complete = f.processor.onInvocationComplete.bind(f.processor);
  f.processor.onInvocationComplete = async (...args) => {
    try {
      return await complete(...args);
    } finally {
      finish();
    }
  };
  await f.processor.requestDrain('thread');
  let timer;
  try {
    await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(JSON.stringify(f.state))), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
for (const options of [{}, { silent: true }, { fail: true }])
  test(`public Queue uses main receiver lifecycle ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    await run(f);
    assert.equal(f.state.starts, 1, JSON.stringify(f.state.errors));
    assert.equal(f.state.prompt, 'public source only');
    assert.deepEqual(f.state.ownerReads, []);
    assert.equal(f.state.disposals, 1);
    const responses = f.store.getByThread('thread').filter((m) => m.from?.kind === 'agent');
    assert.equal(responses.length, 1, 'one canonical History response, no duplicate plugin transcript');
    assert.equal(responses[0].lifecycle.status, options.fail ? 'failed' : 'completed');
    assert.equal(responses[0].extra?.pluginMessage, undefined, 'Host response is not a plugin business reply');
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
    await f.processor.requestDrain('thread');
    assert.equal(f.state.starts, 1, 'retired source must not replay');
  });
