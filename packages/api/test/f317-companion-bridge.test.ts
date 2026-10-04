import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry, createCompanionIdentitySnapshot } from '@cat-cafe/shared';
import { validateCompanionReply } from '@clowder-ai/plugin-contract';
import { validateCompanionReply as validateCompanionReplyBeta20 } from '@clowder-ai/plugin-contract-beta20';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { CompanionF221Trial } from '../src/domains/concierge/live/CompanionF221Trial.js';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import type { CompanionOwnerClient } from '../src/domains/concierge/live/companion-owner-client.js';
import {
  validateHostCompanionCommand,
  validateHostCompanionReply,
} from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';
import { requirePluginOwnerLocalAccess } from '../src/routes/plugin-access-guards.js';

const { toPublishedWindowReply } = createRequire(import.meta.url)('../../../desktop/plugin-window/window.cjs');

const historicalIdentity = createCompanionIdentitySnapshot({
  duty: { catId: 'fable-5', displayName: '宪宪' },
  carrier: { catId: 'codex', displayName: '砚砚' },
  skin: 'black-cat',
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
});

function authorDisplayName(catId: string): string {
  const cat = catRegistry.tryGet(catId);
  assert.ok(cat, `fixture cat ${catId} must exist`);
  return cat.config.displayName;
}

async function fixture() {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'bridge-owner';
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'bridge-owner' });
  const config = new MemoryConciergeConfigStore();
  await config.put('bridge-owner', {
    ...CONCIERGE_CONFIG_DEFAULTS,
    dutyCatProfileId: 'opus',
    displayName: 'My familiar companion',
  });
  const messages = new MessageStore();
  const threads = new ConciergeThreadService({ threadStore: new ThreadStore(), conciergeConfigStore: config });
  await app.register(conciergeRoutes, {
    conciergeConfigStore: config,
    conciergeThreadService: threads,
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: messages,
  });
  const calls: { path: string; body: unknown; owner: string }[] = [];
  const callId = randomUUID();
  let rejected = false;
  let missingCall = false;
  let nativeConflict = false;
  let holdPrepare: Promise<void> | undefined;
  let holdStop: Promise<void> | undefined;
  let previewDigest = 'a'.repeat(64);
  // Native provider seam is synthetic here; canonical cookie and local owner gates are real.
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, request.method === 'GET' ? 'read' : 'write');
      if ('error' in access) return reply.code(access.status).send({ error: access.error });
      if (access.operator !== 'bridge-owner') return reply.code(403).send({ error: 'Wrong owner' });
      calls.push({ path: request.url, body: request.body, owner: access.operator });
    });
    routes.post('/api/concierge/live', async (_request, reply) => {
      if (holdPrepare) await holdPrepare;
      return rejected
        ? reply.code(503).send({ error: '/private/secret', code: 'live_prepare_failed' })
        : reply.code(202).send({ callId, state: 'ready' });
    });
    routes.get('/api/concierge/live/:id', async (_request, reply) =>
      missingCall
        ? reply.code(404).send({ error: 'Live call unavailable' })
        : nativeConflict
          ? { state: 'failed', failureCode: 'native_session_conflict' }
          : {
              callId,
              catId: 'codex',
              state: 'ready',
              toolsReady: true,
              nativeActivity: 'tool_running',
              nativeWork: {
                scopeId: 'a'.repeat(16),
                revision: 1,
                active: [
                  {
                    taskId: `${'a'.repeat(16)}/turn/tool`,
                    nativeTurnId: 'turn',
                    kind: 'workspace_fetch',
                    startedAt: 1000,
                    expiresAt: 301000,
                  },
                ],
                recent: [
                  {
                    eventId: `${'a'.repeat(16)}:1`,
                    taskId: `${'a'.repeat(16)}/turn/tool`,
                    kind: 'workspace_fetch',
                    phase: 'started',
                    occurredAt: 1000,
                    expiresAt: 121000,
                  },
                ],
              },
            },
    );
    routes.get('/api/concierge/work/decisions', async () => ({
      status: 'available',
      approvalCount: 1,
      needsMeCount: 1,
      otherNeedsMeCount: 0,
      approvals: [
        {
          proposalId: 'taste-1',
          sourceFeatureId: 'F221',
          summary: '品味提案',
          resolution: 'open',
          materialization: { state: 'not_started' },
        },
      ],
      otherNeedsMe: [],
      page: { offset: 0, limit: 5, hasMoreApprovals: false, hasMoreNeedsMe: false },
    }));
    routes.get<{ Params: { id: string } }>('/api/taste-proposals/:id/decision-preview', async (request) => ({
      proposalId: request.params.id,
      ownerUserId: 'bridge-owner',
      digest: previewDigest,
      fields: {
        id: request.params.id,
        userId: 'bridge-owner',
        catId: 'codex',
        threadId: 'home',
        sourceMessageId: 'source-1',
        scene: '一起看设计稿',
        quote: '保留一点呼吸感',
        takeaway: '重要的是留白',
        tags: '["留白"]',
        dimension: 'visual-quality',
        privacy: 'sensitive',
        createdAt: '123',
        approvalOriginRef: '',
        publication: JSON.stringify({ state: 'anchored' }),
      },
    }));
    routes.post('/api/concierge/live/:id/start', async () => ({
      answer: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    }));
    routes.post('/api/concierge/live/:id/text', async () => ({ delivery: 'accepted' }));
    const textIds = new Set<string>();
    routes.post('/api/messages', async (request) => {
      const id = (request.body as { idempotencyKey: string }).idempotencyKey;
      if (textIds.has(id)) return { status: 'duplicate', userMessageId: id };
      textIds.add(id);
      return { status: 'processing' };
    });
    routes.get('/api/messages', async () => ({
      messages: [
        { id: 'user-original', type: 'user', content: '窗边的小芽', catId: null },
        { id: 'cat-original', type: 'assistant', content: '我记得。', catId: 'opus' },
        {
          id: 'live-answer',
          type: 'assistant',
          content: '旧日的回答。',
          catId: 'codex',
          extra: { liveCompanion: { identity: historicalIdentity } },
        },
        {
          id: 'different-author',
          type: 'assistant',
          content: '署名仍是原猫。',
          catId: 'opus',
          extra: { liveCompanion: { identity: historicalIdentity } },
        },
        {
          id: 'invalid-snapshot',
          type: 'assistant',
          content: '无效展示快照。',
          catId: 'codex',
          extra: { liveCompanion: { identity: { ...historicalIdentity, name: '另一只猫' } } },
        },
        { id: 'system-note', type: 'system', content: 'internal' },
      ],
      hasMore: true,
    }));
    routes.get('/api/threads/:id', async () => ({ title: '同一段聊天' }));
    routes.delete('/api/concierge/live/:id', async () => {
      if (holdStop) await holdStop;
      return { stopped: true };
    });
  });
  let current = true;
  const opened: string[] = [];
  const options = {
    app,
    ownerUserId: 'bridge-owner',
    origin: 'http://localhost:3011',
    assertCurrent: async () => {
      if (!current) throw new Error('revoked grant; private detail');
    },
    publicCompanionV2: false,
    openConversation: async (threadId: string) => {
      opened.push(threadId);
      return true;
    },
  };
  const bridge = new CompanionHostBridge(options);
  const bridges = [bridge];
  const cleanup = async () => {
    try {
      for (const currentBridge of bridges) await currentBridge.close();
    } finally {
      await app.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  };
  return {
    app,
    bridge,
    callId,
    options,
    config,
    threads,
    calls,
    opened,
    cleanup,
    reopen: () => {
      const next = new CompanionHostBridge(options);
      bridges.push(next);
      return next;
    },
    reject: () => {
      rejected = true;
    },
    missingCall: (value: boolean) => {
      missingCall = value;
    },
    nativeConflict: (value: boolean) => {
      nativeConflict = value;
    },
    revoke: () => {
      current = false;
    },
    setPreviewDigest: (value: string) => {
      previewDigest = value;
    },
    deferPrepare: (pending: Promise<void>) => {
      holdPrepare = pending;
    },
    deferStop: (pending: Promise<void>) => {
      holdStop = pending;
    },
  };
}

test('native writer conflicts reach the existing busy UI boundary and permit a later prepare without stale handles', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.nativeConflict(true);
  assert.deepEqual(await f.bridge.request({ kind: 'prepare' }), { kind: 'error', code: 'busy' });
  f.nativeConflict(false);
  const next = await f.bridge.request({ kind: 'prepare' });
  assert.equal(next.kind, 'state');
  assert.equal(next.phase, 'ready');
  assert.equal(f.calls.filter((row) => row.path === '/api/concierge/live').length, 2);
});

test('idle typing uses the existing owner conversation and duty cat without preparing voice', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const clientMessageId = randomUUID();
  assert.deepEqual(await f.bridge.request({ kind: 'text', text: '窗边的小芽', clientMessageId }), {
    kind: 'delivery',
    delivery: 'accepted',
  });
  const threadId = await f.threads.getOrCreate('bridge-owner');
  assert.deepEqual(f.calls[0].body, { content: '窗边的小芽', threadId, idempotencyKey: clientMessageId });
  assert.ok(f.calls.every((call) => !call.path.includes('/live')));
  assert.deepEqual(await f.bridge.request({ kind: 'text', text: '窗边的小芽', clientMessageId }), {
    kind: 'delivery',
    delivery: 'accepted',
  });
  const history = await f.bridge.request({ kind: 'conversation.read' });
  assert.deepEqual(history, {
    kind: 'conversation',
    threadTitle: '同一段聊天',
    messages: [
      { id: 'user-original', role: 'user', text: '窗边的小芽', name: '你' },
      {
        id: 'cat-original',
        role: 'assistant',
        text: '我记得。',
        name: authorDisplayName('opus'),
      },
      {
        id: 'live-answer',
        role: 'assistant',
        text: '旧日的回答。',
        name: authorDisplayName('codex'),
      },
      {
        id: 'different-author',
        role: 'assistant',
        text: '署名仍是原猫。',
        name: authorDisplayName('opus'),
      },
      {
        id: 'invalid-snapshot',
        role: 'assistant',
        text: '无效展示快照。',
        name: authorDisplayName('codex'),
      },
    ],
    hasMore: true,
  });
  assert.equal(validateCompanionReplyBeta20(history), true, 'old consumers keep their exact beta.20 reply');
  assert.equal(f.calls.at(-1).path, `/api/messages?threadId=${threadId}&limit=32`);
  f.revoke();
  assert.equal((await f.bridge.request({ kind: 'conversation.read' })).kind, 'error');
  assert.equal((await f.bridge.request({ kind: 'text', text: 'no', clientMessageId })).kind, 'error');
});

test('beta.21 history exposes only author-matched saved identity while beta.20 remains strict', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const bridge = new CompanionHostBridge({ ...f.options, publicCompanionV2: true });
  t.after(() => bridge.close());

  const history = await bridge.request({ kind: 'conversation.read' });
  assert.equal(history.kind, 'conversation');
  if (history.kind !== 'conversation') return;
  assert.equal(validateCompanionReply(history), true);
  assert.equal(validateCompanionReplyBeta20(history), false, 'beta.20 rejects the new per-message field');
  assert.deepEqual(
    history.messages.map((message) => message.id),
    ['user-original', 'cat-original', 'live-answer', 'different-author', 'invalid-snapshot'],
  );
  assert.deepEqual(
    history.messages.find((message) => message.id === 'live-answer'),
    {
      id: 'live-answer',
      role: 'assistant',
      text: '旧日的回答。',
      name: authorDisplayName('codex'),
      companionIdentity: historicalIdentity,
    },
  );
  assert.deepEqual(
    history.messages.find((message) => message.id === 'different-author'),
    {
      id: 'different-author',
      role: 'assistant',
      text: '署名仍是原猫。',
      name: authorDisplayName('opus'),
    },
  );
  assert.deepEqual(
    history.messages.find((message) => message.id === 'invalid-snapshot'),
    {
      id: 'invalid-snapshot',
      role: 'assistant',
      text: '无效展示快照。',
      name: authorDisplayName('codex'),
    },
  );
});

test('owner Host reads bounded real decisions without approval handles', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const decisions = await f.bridge.request({ kind: 'decisions.read', offset: 0, limit: 5 });
  assert.equal(decisions.kind, 'decisions');
  if (decisions.kind === 'decisions') {
    assert.equal(decisions.status, 'available');
    assert.equal(decisions.approvalCount, 1);
    assert.deepEqual(decisions.approvals, [
      {
        proposalId: 'taste-1',
        sourceFeatureId: 'F221',
        summary: '品味提案',
        resolution: 'open',
        materializationState: 'not_started',
        linkedNeedsMe: false,
      },
    ]);
  }
  assert.equal(validateHostCompanionCommand({ kind: 'f221.inspect', proposalId: '../other-owner' }), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.path, '/api/concierge/work/decisions?offset=0&limit=5');
});

test('F221 Host preview binds an exact snapshot to one private trial and never calls a writer', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const proposalId = 'proposal_mgf2abc12345678';
  assert.equal(validateHostCompanionCommand({ kind: 'f221.inspect', proposalId }), true);
  const preview = await f.bridge.request({ kind: 'f221.inspect', proposalId });
  assert.equal(preview.kind, 'f221-preview');
  if (preview.kind !== 'f221-preview') return;
  assert.equal(preview.snapshot.fields.takeaway, '重要的是留白');
  assert.match(preview.snapshot.nonce, /^[0-9a-f]{48}$/);
  const command = { kind: 'f221.confirm-trial', nonce: preview.snapshot.nonce, action: 'approve' };
  const receipt = await f.bridge.request(command);
  assert.equal(receipt.kind, 'f221-trial-receipt');
  if (receipt.kind === 'f221-trial-receipt') {
    assert.equal(receipt.proposalId, proposalId);
    assert.equal(receipt.digest, preview.snapshot.digest);
    assert.equal(receipt.action, 'approve');
  }
  assert.deepEqual(await f.bridge.request(command), { kind: 'decision-trial', status: 'stale' });
  assert.deepEqual(await f.bridge.request({ kind: 'f221.inspect', proposalId, digest: 'forged' }), {
    kind: 'error',
    code: 'invalid_request',
  });
  assert.equal(f.calls.filter((call) => /\/approve|\/reject/u.test(call.path)).length, 0);
});

test('F221 Host trial consumes a changed digest and is revoked by stop', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const proposalId = randomUUID();
  const preview = await f.bridge.request({ kind: 'f221.inspect', proposalId });
  assert.equal(preview.kind, 'f221-preview');
  if (preview.kind !== 'f221-preview') return;
  f.setPreviewDigest('c'.repeat(64));
  const command = { kind: 'f221.confirm-trial', nonce: preview.snapshot.nonce, action: 'reject' };
  assert.deepEqual(await f.bridge.request(command), { kind: 'decision-trial', status: 'stale' });
  const next = await f.bridge.request({ kind: 'f221.inspect', proposalId });
  assert.equal(next.kind, 'f221-preview');
  if (next.kind !== 'f221-preview') return;
  await f.bridge.request({ kind: 'stop' });
  assert.deepEqual(
    await f.bridge.request({ kind: 'f221.confirm-trial', nonce: next.snapshot.nonce, action: 'approve' }),
    { kind: 'decision-trial', status: 'stale' },
  );
  assert.equal(f.calls.filter((call) => /\/approve|\/reject/u.test(call.path)).length, 0);
});

test('F221 private trial expires and simultaneous confirmations consume one nonce once', async () => {
  const proposalId = randomUUID();
  let clock = 1000;
  let reads = 0;
  const client = {
    request: async () => {
      reads++;
      return {
        proposalId,
        ownerUserId: 'owner',
        digest: 'a'.repeat(64),
        fields: {
          id: proposalId,
          userId: 'owner',
          catId: 'codex',
          threadId: 'home',
          sourceMessageId: 'source',
          scene: '场景',
          quote: '原话',
          takeaway: '',
          tags: '[]',
          dimension: 'visual-quality',
          privacy: 'public',
          createdAt: '123',
          approvalOriginRef: '',
          publication: JSON.stringify({ state: 'anchored' }),
        },
      };
    },
  } as unknown as CompanionOwnerClient;
  const trial = new CompanionF221Trial(
    client,
    'owner',
    () => ({ generation: 0 }),
    () => clock,
  );
  const first = await trial.inspect(proposalId);
  assert.equal(first.kind, 'f221-preview');
  if (first.kind !== 'f221-preview') return;
  clock += 120_001;
  assert.deepEqual(await trial.confirm(first.snapshot.nonce, 'approve'), { kind: 'decision-trial', status: 'stale' });
  assert.equal(reads, 1);
  const next = await trial.inspect(proposalId);
  assert.equal(next.kind, 'f221-preview');
  if (next.kind !== 'f221-preview') return;
  const [accepted, replay] = await Promise.all([
    trial.confirm(next.snapshot.nonce, 'approve'),
    trial.confirm(next.snapshot.nonce, 'reject'),
  ]);
  assert.equal(accepted.kind, 'f221-trial-receipt');
  assert.deepEqual(replay, { kind: 'decision-trial', status: 'stale' });
  assert.equal(reads, 3);
});

test('bridge 1.3 voice answer carries the current Host call identity', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.bridge.request({ kind: 'prepare' });
  assert.deepEqual(await f.bridge.request({ kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }), {
    kind: 'answer',
    sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    callId: f.callId,
  });
});

test('bridge binds to its Host owner and existing conversation without exposing call or login credentials', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const state = await f.bridge.request({ kind: 'state' });
  assert.equal(state.kind, 'state');
  if (state.kind !== 'state') return;
  assert.equal(state.displayName, 'My familiar companion');
  assert.deepEqual(state.liveTransport, { kind: 'gpt_live_v3', verifiedModel: null });
  assert.deepEqual(state.nativeWork, { scopeId: null, revision: 0, active: [], recent: [] });
  assert.equal(validateHostCompanionReply(state), true);
  assert.equal('behaviorEnabled' in state && state.behaviorEnabled, true);
  assert.equal(
    validateCompanionReplyBeta20(toPublishedWindowReply(state)),
    true,
    'the renderer receives the published beta.20 state',
  );
  assert.equal(state.duty.catId, 'opus');
  assert.equal(state.carrier.catId, 'codex');
  assert.equal(state.documentsAllowed, true);
  assert.doesNotMatch(JSON.stringify(state), /cookie|token|callId|threadId/);
  const prepared = await f.bridge.request({ kind: 'prepare' });
  assert.equal(prepared.kind, 'state');
  if (prepared.kind === 'state') {
    assert.equal(prepared.nativeActivity, 'tool_running');
    assert.equal(prepared.nativeWork.active[0]?.kind, 'workspace_fetch');
    assert.equal(validateHostCompanionReply(prepared), true);
    assert.equal(
      validateCompanionReplyBeta20(toPublishedWindowReply(prepared)),
      true,
      'active state must satisfy the published beta.20 consumer',
    );
  }
  const receipt = await f.bridge.request({ kind: 'text', text: 'unfamiliar-sentinel', clientMessageId: randomUUID() });
  assert.deepEqual(receipt, { kind: 'delivery', delivery: 'accepted' });
  assert.deepEqual(f.calls[0]?.body, { allowHomeReads: true });
  assert.ok(f.calls.every((call) => call.owner === 'bridge-owner'));
  assert.deepEqual(await f.bridge.request({ kind: 'conversation.open' }), {
    kind: 'navigation',
    delivery: 'requested',
  });
  assert.deepEqual(f.opened, [await f.threads.getOrCreate('bridge-owner')]);
});

test('a call retired by the Host does not leave the desktop permanently busy', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.equal((await f.bridge.request({ kind: 'prepare' })).kind, 'state');
  f.missingCall(true);
  const closed = await f.bridge.request({ kind: 'state' });
  assert.equal(closed.kind, 'state');
  if (closed.kind === 'state') assert.equal(closed.phase, 'closed');
  f.missingCall(false);
  assert.equal((await f.bridge.request({ kind: 'prepare' })).kind, 'state');
});

test('untrusted identity input and revoked installations cause no Host effect; raw errors stay private', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.deepEqual(await f.bridge.request({ kind: 'prepare', catId: 'opus' }), {
    kind: 'error',
    code: 'invalid_request',
  });
  assert.equal(f.calls.length, 0);
  f.reject();
  assert.deepEqual(await f.bridge.request({ kind: 'prepare' }), { kind: 'error', code: 'unavailable' });
  const before = f.calls.length;
  f.revoke();
  assert.deepEqual(await f.bridge.request({ kind: 'prepare' }), { kind: 'error', code: 'unavailable' });
  assert.equal(f.calls.length, before);
});

test('household preference lives in existing config and survives closing the desktop bridge', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const changed = await f.bridge.request({ kind: 'documents', allowed: false });
  assert.equal(changed.kind, 'state');
  await f.bridge.close();
  const reopened = f.reopen();
  const state = await reopened.request({ kind: 'state' });
  assert.equal(state.kind, 'state');
  if (state.kind === 'state') assert.equal(state.documentsAllowed, false);
  await reopened.request({ kind: 'prepare' });
  assert.deepEqual(f.calls.find((r) => r.path === '/api/concierge/live')?.body, { allowHomeReads: false });
});

test('ending while prepare is pending cleans only the late-created call and never returns ready', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let release!: () => void;
  f.deferPrepare(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const pending = f.bridge.request({ kind: 'prepare' });
  for (let attempt = 0; attempt < 100 && !f.calls.some((r) => r.path === '/api/concierge/live'); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!f.calls.some((r) => r.path === '/api/concierge/live')) {
    release();
    assert.fail('prepare must enter its owner route');
  }
  const stopping = f.bridge.close();
  release();
  assert.deepEqual(await pending, { kind: 'error', code: 'cancelled' });
  await stopping;
  assert.equal(f.calls.filter((r) => r.path !== '/api/concierge/live').length, 1, 'only its late call is deleted');
});

test('a household preference transition blocks a concurrent prepare until the saved choice is effective', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.equal((await f.bridge.request({ kind: 'prepare' })).kind, 'state');
  let release!: () => void;
  f.deferStop(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const changing = f.bridge.request({ kind: 'documents', allowed: false });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await f.bridge.request({ kind: 'prepare' }), { kind: 'error', code: 'busy' });
  } finally {
    release();
  }
  assert.equal((await changing).kind, 'state');
  assert.equal((await f.bridge.request({ kind: 'prepare' })).kind, 'state');
  assert.deepEqual(
    f.calls.filter((r) => r.path === '/api/concierge/live').map((r) => r.body),
    [{ allowHomeReads: true }, { allowHomeReads: false }],
  );
});
