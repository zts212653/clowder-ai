import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveProjectAttentionActionRef, collectiveProjectAttentionSubjectRef } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';

function runtimeItem(kind = 'conversation_decision', revision = 2) {
  return {
    decisionRef: 'f306.runtime_interaction:pending-choice',
    kind: 'judgment',
    summary: '选择下一步',
    linkedNeedsMe: [],
    runtimeInteraction: {
      interactionId: 'pending-choice',
      revision,
      requesterCatId: 'codex61-sol',
      createdAt: 1,
      title: '选择下一步',
      kind,
      sourceKind: kind === 'conversation_decision' ? 'conversation_decision' : 'provider_request',
      cardRef: {
        threadId: 'original-thread',
        messageId: 'original-message',
        blockId: 'choice-card',
        blockDigest: 'a'.repeat(64),
        publishedAt: 1,
      },
      ...(kind === 'conversation_decision'
        ? {
            allowTextResponse: true,
            presentation: {
              kind: 'interactive',
              v: 1,
              id: 'choice-card',
              interactiveType: 'select',
              options: [{ id: 'next', label: '继续' }],
            },
          }
        : {}),
    },
  };
}

function page(items: unknown[] = [runtimeItem()]) {
  const source = { status: 'available', exhaustiveness: 'complete', startedAt: 1, observedAt: 2 };
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner' },
    observedAt: 2,
    sources: {
      approvals: { ...source, coverage: 'all_registered_F246_producers' },
      needsMe: { ...source, coverage: 'current_linked_F310_five_producers' },
      structuredChoices: { ...source, coverage: 'pending_f306_structured_choices' },
    },
    readWindow: { startedAt: 1, endedAt: 2, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items,
    totalCount: items.length,
    page: { offset: 0, limit: 10, scope: 'known_rows', hasMore: false },
  };
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner' });
  let current: unknown = page();
  const opened: object[] = [];
  app.get('/api/concierge/work/decisions', async () => current);
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: 'owner',
    origin: 'http://127.0.0.1:3102',
    publicCompanionV2: true,
    companionContract: '0.1.0-beta.29',
    assertCurrent: async () => {},
    openConversation: async () => false,
    canOpenDecision: async () => true,
    openDecision: async (destination) => {
      opened.push(destination);
      return true;
    },
  });
  return {
    opened,
    set: (value: unknown) => {
      current = value;
    },
    read: () => bridge.request({ kind: 'decisions.read', offset: 0, limit: 10 }),
    open: (variantRef: string) => bridge.request({ kind: 'decision.open', variantRef, target: 'action' }),
  };
}

test('pending runtime cards update the desktop count and open only their current original card', async (t) => {
  const f = await fixture(t);
  for (const kind of ['conversation_decision', 'approval', 'question', 'elicitation']) {
    f.set(page([runtimeItem(kind)]));
    const reply = await f.read();
    assert.ok('items' in reply, `${kind} must remain readable`);
    assert.equal(reply.totalCount, 1);
    const ref = reply.items[0]!.variantRef;
    assert.deepEqual(await f.open(ref), { kind: 'navigation', delivery: 'requested' });
    assert.deepEqual(f.opened.at(-1), {
      threadId: 'original-thread',
      messageId: 'original-message',
      blockId: 'choice-card',
    });
    assert.equal(JSON.stringify(reply).includes('original-thread'), false);
    f.set(page([runtimeItem(kind, 3)]));
    assert.deepEqual(await f.open(ref), { kind: 'navigation', delivery: 'unconfirmed' });
    const newer = await f.read();
    assert.ok('items' in newer);
    assert.notEqual(newer.items[0]!.variantRef, ref, 'card revisions cannot reuse navigation authority');
  }
  f.set(page([]));
  const empty = await f.read();
  assert.ok('totalCount' in empty);
  assert.equal(empty.totalCount, 0, 'handled cards leave the next authoritative read');
});

test('runtime source failures retain uncertainty and mismatched cards cannot issue navigation authority', async (t) => {
  const f = await fixture(t);
  const value = page([]);
  const unavailable = {
    ...value,
    status: 'partial',
    totalCount: undefined,
    sources: {
      ...value.sources,
      structuredChoices: { ...value.sources.structuredChoices, status: 'unavailable', exhaustiveness: 'unknown' },
    },
  };
  f.set(unavailable);
  const partial = await f.read();
  assert.ok('items' in partial);
  assert.equal(partial.status, 'partial');
  assert.equal('totalCount' in partial, false);
  assert.deepEqual(partial.sources.needsMe, { status: 'unavailable', coverage: 'unknown' });
  f.set({ ...unavailable, items: [runtimeItem()] });
  assert.deepEqual(await f.read(), { kind: 'error', code: 'unavailable' });
  const item = runtimeItem();
  for (const invalid of [
    { ...item, decisionRef: 'f306.runtime_interaction:another-card' },
    { ...item, kind: 'repair' },
    { ...item, runtimeInteraction: { ...item.runtimeInteraction, revision: -1 } },
    {
      ...item,
      runtimeInteraction: {
        ...item.runtimeInteraction,
        cardRef: { ...item.runtimeInteraction.cardRef, blockId: 'different-block' },
      },
    },
  ]) {
    f.set(page([invalid]));
    assert.deepEqual(await f.read(), { kind: 'error', code: 'unavailable' });
  }
  f.set(page());
  const recovered = await f.read();
  assert.ok('totalCount' in recovered);
  assert.equal(recovered.totalCount, 1, 'a later read recovers without resetting the companion');
});

test('another canonical unlinked producer does not poison the whole desktop inbox', async (t) => {
  const f = await fixture(t);
  const identity = {
    serviceInstanceId: 'svc_12345678',
    collectiveId: 'col_12345678',
    connectionId: 'con_12345678',
    roadmapId: 'roadmap_12345678',
    targetHumanId: 'human_12345678',
    channelId: 'channel',
    kind: 'triage' as const,
  };
  const project = {
    ...identity,
    producerId: 'f290.collective_project_attention',
    subjectRef: collectiveProjectAttentionSubjectRef(identity),
    actionRef: collectiveProjectAttentionActionRef(identity),
    projectTitle: '待核材料',
    expectedProducerRevision: 1,
    count: 1,
    sinceAt: '2026-10-30T00:00:00.000Z',
  };
  const value = page([
    {
      decisionRef: `${project.producerId}:${project.subjectRef}`,
      kind: 'judgment',
      summary: '请核对材料',
      linkedNeedsMe: [],
      collectiveProjectAttention: project,
    },
  ]);
  f.set({
    ...value,
    sources: {
      ...value.sources,
      collectiveProjectAttention: {
        ...value.sources.structuredChoices,
        coverage: 'pending_f290_project_materials_and_dates',
      },
    },
  });
  const result = await f.read();
  assert.ok('items' in result);
  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0]?.summary, '请核对材料');
  assert.deepEqual(result.items[0]?.navigation.targets, [], 'a project URL cannot be promoted to a message action');
});
