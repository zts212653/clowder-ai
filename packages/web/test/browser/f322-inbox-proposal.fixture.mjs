import assert from 'node:assert/strict';
import { catRegistry } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import '../../../api/test/helpers/setup-cat-registry.js';
import { F128ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProposalStore } from '../../../api/dist/domains/cats/services/stores/ports/ProposalStore.js';
import { ThreadStore } from '../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js';
import { sessionAuthPlugin, sessionRoute } from '../../../api/dist/infrastructure/session-auth.js';
import { approvalHubRoutes } from '../../../api/dist/routes/approval-hub-routes.js';
import { companionDecisionRoutes } from '../../../api/dist/routes/companion-decision-routes.js';
import { buildProposalCardBlock } from '../../../api/dist/routes/proposal-card-block.js';
import { proposalRoutes } from '../../../api/dist/routes/proposal-routes.js';
import { threadsRoutes } from '../../../api/dist/routes/threads.js';
import { createTestApprovalRegistry } from '../../../api/test/approval-hub/helpers.js';
import { CALENDAR_THREAD, createCalendarFixture } from './f310-work-calendar.fixture.mjs';

/** Original producer/store/routes, owner publication and private draft/preferences; no provider or Redis connection. */
export async function createInboxProposalFixture({
  readStateStore,
  configureRuntime,
  configureApprovals,
  configureOwnedReads,
  readIgnoredPreferences,
  ownerUserId = 'default-user',
  participantIds = ['codex61-sol'],
  threadStore,
  messageStore,
} = {}) {
  const original = await createCalendarFixture();
  const app = Fastify();
  let approvalSources;
  try {
    if (!catRegistry.has('codex61-sol')) {
      catRegistry.register('codex61-sol', {
        ...catRegistry.getOrThrow('codex-sol').config,
        id: 'codex61-sol',
        displayName: '缅因猫 Sol',
        defaultModel: 'gpt-6.1-sol',
        avatar: '/avatars/family/codex61-sol.png',
        mentionPatterns: ['@codex61-sol'],
      });
    }
    const owner = ownerUserId;
    const proposals = new InMemoryProposalStore();
    const threads = threadStore ?? new ThreadStore();
    const messages = messageStore ?? new MessageStore();
    messages.initializeUserMentionInbox(0);
    threads.ensureThread(CALENDAR_THREAD, 'Controlled source conversation');
    const parent = threads.create(owner, 'Parent project discussion', 'default');
    const alternateParent = threads.create(owner, 'Alternate verification discussion', 'default');
    const initialMessage =
      '**Start with the actual evidence**\n\n' + '- Preserve the source and verify the complete result.\n'.repeat(60);
    const records = [];
    for (const action of ['approve', 'reject']) {
      const origin = messages.append({
        userId: owner,
        threadId: CALENDAR_THREAD,
        from: { kind: 'user', userId: owner },
        content: `Controlled ${action} authorization sample`,
        timestamp: Date.now(),
      });
      const record = proposals.create({
        proposalId: `inbox-native-${action}`,
        sourceThreadId: CALENDAR_THREAD,
        sourceInvocationId: `controlled-${action}`,
        sourceCatId: 'codex61-sol',
        sourceMessageId: origin.id,
        title: `Native new conversation ${action}`,
        reason: 'Investigate the **actual evidence** and preserve the accepted result.',
        parentThreadId: parent.id,
        preferredCats: ['codex61-sol'],
        initialMessage,
        projectPath: 'default',
        declaredWorkMode: 'investigation',
        reportingMode: 'final-only',
        createdBy: owner,
      });
      const card = messages.append({
        userId: owner,
        threadId: CALENDAR_THREAD,
        from: { kind: 'agent', catId: record.sourceCatId },
        content: record.reason,
        timestamp: Date.now(),
        extra: { rich: { blocks: [buildProposalCardBlock(record)] } },
      });
      proposals.setCardMessageId(record.proposalId, card.id);
      proposals.commitEnvelope(record.proposalId, {
        canonicalProposalId: record.proposalId,
        ownerUserId: owner,
        requesterCatId: record.sourceCatId,
        sourceFeatureId: 'F128',
        createdAt: record.createdAt,
        originRef: { kind: 'message', threadId: CALENDAR_THREAD, messageId: origin.id },
        approvalCardRef: { threadId: CALENDAR_THREAD, messageId: card.id },
      });
      records.push(proposals.get(record.proposalId));
    }
    const mutations = [],
      reads = [],
      readReceipts = [],
      approvalResponses = [];
    app.addHook('onRequest', async (request, reply) => {
      reply
        .header('Access-Control-Allow-Origin', request.headers.origin ?? '*')
        .header('Access-Control-Allow-Credentials', 'true')
        .header('Access-Control-Allow-Headers', 'Content-Type,x-cat-cafe-user,x-csrf-token')
        .header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      if (request.method === 'OPTIONS') return reply.send();
    });
    app.addHook('preHandler', async (request) => {
      if (request.method !== 'GET' && request.method !== 'OPTIONS')
        mutations.push({ method: request.method, path: request.url.split('?')[0], body: request.body });
    });
    app.addHook('onSend', async (request, _reply, payload) => {
      if (request.method === 'POST' && /\/api\/proposals\/[^/]+\/approve$/.test(request.url)) {
        const body = JSON.parse(String(payload));
        approvalResponses.push({
          path: request.url,
          threadId: body.threadId,
          pinned: body.threadId ? (await threads.get(body.threadId))?.pinned : undefined,
        });
      }
      if (
        (request.method === 'POST' || request.method === 'PATCH') &&
        /\/read(?:\/latest)?$|\/read\/mark-all$/.test(request.url)
      )
        readReceipts.push({ path: request.url, body: JSON.parse(String(payload)) });
      return payload;
    });
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: owner });
    const socketManager = { emitToUser() {}, broadcastToRoom() {} };
    const runtime = await configureRuntime?.({ app, owner, messages, threads, socketManager });
    approvalSources = await configureApprovals?.({ app, owner, messages, threads, socketManager });
    const registry = await createTestApprovalRegistry([
      new F128ApprovalAdapter(proposals),
      ...(approvalSources?.adapters ?? []),
    ]);
    await app.register(proposalRoutes, {
      proposalStore: proposals,
      threadStore: threads,
      messageStore: messages,
      socketManager,
    });
    await app.register(threadsRoutes, { threadStore: threads, messageStore: messages, socketManager, readStateStore });
    await app.register(approvalHubRoutes, { registry });
    // This disposable member DTO represents the named participant in this controlled sample.
    // It does not assert availability or execute a live provider.
    app.get('/api/cats', async () => ({
      cats: participantIds.map((catId) => ({
        id: catId,
        displayName: catRegistry.getOrThrow(catId).config.displayName,
        nickname: catId === 'codex61-sol' ? '小太阳·砚砚' : catRegistry.getOrThrow(catId).config.displayName,
        defaultModel: catRegistry.getOrThrow(catId).config.defaultModel,
        clientId: 'openai',
        carrier: 'cli',
        avatar: catRegistry.getOrThrow(catId).config.avatar ?? '/avatars/family/codex61-sol.png',
        color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
        mentionPatterns: [`@${catId}`],
        roleDescription: 'Controlled named participant; no provider dispatch',
        personality: '',
      })),
    }));
    // Keep the original decision read/auth/title/proof path. Only the absent Work source is an empty owned port.
    if (configureOwnedReads) await configureOwnedReads({ app, owner, messages, threads, socketManager });
    else app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
    await app.register(companionDecisionRoutes, {
      ownerUserId: owner,
      messageStore: messages,
      threadStore: threads,
      runtimeInteractionStore: runtime?.store ?? {
        async listPendingByUser() {
          return [];
        },
        async readPendingIndexByUser() {
          return { records: [], exhaustiveness: 'complete' };
        },
      },
      readIgnoredItemPreferences: (owner) => readIgnoredPreferences?.(owner) ?? original.preferenceSnapshot(),
      now: Date.now,
    });
    app.addHook('onSend', async (request, reply, payload) => {
      if (
        request.method === 'GET' &&
        request.url.startsWith('/api/concierge/work/decisions?') &&
        reply.statusCode === 200
      )
        reads.push(JSON.parse(String(payload)));
      return payload;
    });
    app.get('/api/messages', async (request) => {
      const url = new URL(request.url, 'http://controlled.local');
      const threadId = url.searchParams.get('threadId') ?? CALENDAR_THREAD;
      if (threadId !== CALENDAR_THREAD) return { messages: messages.getByThread(threadId, 100, owner), hasMore: false };
      const body = await (await fetch(`http://127.0.0.1:${original.apiPort}${request.url}`)).json();
      return { ...body, messages: [...body.messages, ...messages.getByThread(threadId, 100, owner)] };
    });
    app.all('/*', async (request, reply) => {
      const headers = { ...request.headers };
      delete headers.host;
      delete headers['content-length'];
      const response = await fetch(`http://127.0.0.1:${original.apiPort}${request.url}`, {
        method: request.method,
        headers,
        ...(request.method !== 'GET' && request.method !== 'HEAD' ? { body: JSON.stringify(request.body ?? {}) } : {}),
      });
      reply.code(response.status);
      for (const [key, value] of response.headers)
        if (!['transfer-encoding', 'connection', 'content-length', 'content-encoding'].includes(key))
          reply.header(key, value);
      return reply.send(Buffer.from(await response.arrayBuffer()));
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await registry.listPending(owner)).length, 2 + (approvalSources?.records.length ?? 0));
    return {
      apiPort: app.server.address().port,
      proposals,
      threads,
      messages,
      records,
      parent,
      alternateParent,
      mutations,
      reads,
      readReceipts,
      approvalResponses,
      original,
      runtime,
      approvalSources,
      async close() {
        await runtime?.close();
        await Promise.all([app.close(), original.close(), approvalSources?.close()]);
      },
    };
  } catch (error) {
    await Promise.all([app.close(), original.close(), approvalSources?.close()]);
    throw error;
  }
}
