import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import '../../../api/test/helpers/setup-cat-registry.js';
import { catRegistry } from '@cat-cafe/shared';
import { InvocationQueue } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProposalStore } from '../../../api/dist/domains/cats/services/stores/ports/ProposalStore.js';
import { registerCallbackAuthHook } from '../../../api/dist/routes/callback-auth-prehandler.js';
import { registerCallbackProposeThreadRoutes } from '../../../api/dist/routes/callback-propose-thread-routes.js';
import { proposalRoutes } from '../../../api/dist/routes/proposal-routes.js';

/** Isolated owner + real callback, Queue, publication, approval and Group writers; no provider calls. */
export async function installProposalV2Fixture(app, { store, owner, root }) {
  const project = path.join(root, 'cat-cafe');
  await mkdir(project, { recursive: true });
  const catalog = [
    ['opus55', '宪宪', 'opus', 'claude-opus-5-5'],
    ['codex-astra', '小星星', 'codex', 'gpt-6-astra'],
    ['codex61-sol', '小太阳 6.1', 'codex', 'gpt-6.1-sol'],
    ['codex-sol', '小太阳 5.6', 'codex', 'gpt-5.6-sol'],
    ['gemini-argon', '烁烁 Argon', 'gemini', 'gemini-4-argon-high'],
  ];
  for (const [id, nickname, base, defaultModel] of catalog) {
    if (!catRegistry.has(id))
      catRegistry.register(id, {
        ...catRegistry.getOrThrow(base).config,
        id,
        nickname,
        displayName: nickname,
        defaultModel,
        mentionPatterns: [`@${id}`],
      });
  }
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const proposalStore = new InMemoryProposalStore();
  const socketManager = { emitToUser() {}, broadcastToRoom() {} };
  const jobs = new Set();
  const failures = [];
  const queue = new InvocationQueue(undefined, {
    onAdmitted({ message }) {
      if (!message) return;
      const job = new Promise((resolve) => setImmediate(resolve))
        .then(async () => {
          const old = (await proposalStore.listAllByThread(message.threadId)).find(
            (proposal) => proposal.revisionRequest?.messageId === message.id,
          );
          if (!old) return;
          await propose(message.threadId, message.id, {
            title: old.title,
            reason: '按你说的改了：Argon 审，6.1 先开口',
            supersedesProposalId: old.proposalId,
            preferredCats: ['codex61-sol', 'gemini-argon'],
            initialMessage: '按 F330 分工：小太阳 6.1 执行，Argon 审。先做隔离准备。',
          });
        })
        .catch((error) => failures.push(String(error)))
        .finally(() => jobs.delete(job));
      jobs.add(job);
    },
  });
  await app.register(async (callbacks) => {
    registerCallbackAuthHook(callbacks, registry);
    registerCallbackProposeThreadRoutes(callbacks, {
      registry,
      threadStore: store,
      messageStore,
      proposalStore,
      socketManager,
      projectRoot: root,
    });
  });
  await app.register(proposalRoutes, {
    projectRoot: root,
    proposalStore,
    threadStore: store,
    messageStore,
    socketManager,
    invocationQueue: queue,
    router: {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: 'execute' };
      },
    },
  });
  let source;
  async function propose(threadId, originId, body) {
    const { invocationId, callbackToken } = await registry.create(owner, 'opus55', threadId, undefined, originId);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-thread',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: body,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  const createGroup = async (threadIds, name) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      payload: { action: 'create', threadIds, name },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().groups.find((group) => group.threadIds.includes(threadIds[0]));
  };
  app.post('/__test/proposal-v2', async () => {
    source = store.create(owner, '每日漫谈与守望', project);
    store.updatePin(source.id, true);
    const release = store.create(owner, 'F330 发版准备', project);
    const releaseGroup = await createGroup([source.id, release.id], 'F330 发版');
    const planet = Array.from({ length: 34 }, (_, index) =>
      store.create(owner, `F329 ${index === 0 ? '猫猫星球 · 建模' : `溪村地形 ${index + 1}`}`, project),
    );
    const planetGroup = await createGroup(
      planet.slice(0, 20).map((thread) => thread.id),
      'F329「猫猫星球」游戏',
    );
    const origin = await messageStore.append({
      from: { kind: 'user', userId: owner },
      userId: owner,
      threadId: source.id,
      content: '把 F330 的发版单独做。',
      mentions: [],
      timestamp: Date.now(),
    });
    const proposal = await propose(source.id, origin.id, {
      title: 'F330 Phase C：next 汇流、main 发版',
      reason: 'Phase A、B 已完成，C 的前提已满足；隔离准备现在就能做，正式切换等你定默认分支与发版节奏（OQ-1）。',
      preferredCats: ['codex-astra', 'codex61-sol', 'codex-sol'],
      initialMessage: '按 F330 分工：小星星指挥，Sol6.1 执行，Sol5.6 审。先做隔离准备……',
      projectPath: project,
      reportingMode: 'final-only',
      declaredWorkMode: 'subtask',
    });
    return { sourceThreadId: source.id, releaseGroup, planetGroup, proposalId: proposal.proposalId };
  });
  app.get('/__test/proposal-cards', async () => {
    if (failures.length) throw new Error(failures.join('\n'));
    const proposals = source
      ? (await proposalStore.listAllByThread(source.id)).sort((a, b) => a.createdAt - b.createdAt)
      : [];
    const cards = await Promise.all(
      proposals.map(async (proposal) => {
        const message = await messageStore.getById(proposal.cardMessageId);
        return { proposal, messageId: message.id, block: message.extra.rich.blocks[0] };
      }),
    );
    return { sourceThreadId: source?.id, cards };
  });
  app.get('/__test/proposal-state', async () => ({
    proposals: source ? await proposalStore.listAllByThread(source.id) : [],
    failures,
  }));
  return {
    cats: catalog.map(([id, nickname]) => ({
      ...catRegistry.getOrThrow(id).config,
      id,
      nickname,
      displayName: nickname,
      carrier: 'cli',
      clientId: id.startsWith('gemini') ? 'gemini' : id.startsWith('opus') ? 'claude' : 'codex',
    })),
    async close() {
      await Promise.allSettled([...jobs]);
    },
  };
}
