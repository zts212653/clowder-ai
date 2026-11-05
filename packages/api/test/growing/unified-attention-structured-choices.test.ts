import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type RuntimeInteractionRecord,
  type RuntimeInteractionRequest,
  unifiedAttentionChoiceRequestSchema,
} from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryRuntimeInteractionStore } from '../../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';
import { RedisRuntimeInteractionStore } from '../../src/domains/runtime-interaction/stores/RedisRuntimeInteractionStore.js';
import { readCompanionDecisionProjection } from '../../src/routes/companion-decision-read-service.js';
import { registerCompanionWorkReadRoutes } from '../../src/routes/companion-work-read.js';
import { approval, receipt, work } from './unified-attention-fixtures.js';

const owner = { userId: 'owner', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-question' };
const provider = {
  providerId: 'openai',
  method: 'item/tool/requestUserInput',
  requestId: 1,
  threadId: 'provider-thread',
  turnId: 'provider-turn',
  itemId: 'provider-item',
};
const question: RuntimeInteractionRequest = {
  version: 1,
  interactionId: 'choice-1',
  kind: 'question',
  owner,
  provider,
  createdAt: 10,
  title: 'Codex needs your answer',
  entrustedWorkTaskRef: { subjectRef: 'task:work:one', observedRevision: 3 },
  questions: [
    {
      id: 'environment',
      header: 'Environment',
      question: 'Where should I run this?',
      options: [{ label: 'Alpha', description: 'Use the isolated environment' }],
    },
  ],
};

async function populatedStore(): Promise<InMemoryRuntimeInteractionStore> {
  const store = new InMemoryRuntimeInteractionStore();
  const nonQuestions: RuntimeInteractionRequest[] = [
    {
      version: 1,
      interactionId: 'approval-1',
      kind: 'approval',
      owner: { ...owner, invocationId: 'inv-approval' },
      provider: { ...provider, method: 'item/fileChange/requestApproval', requestId: 2 },
      createdAt: 9,
      title: 'Apply files?',
      decisions: [{ id: 'accept', label: 'Allow', outcome: 'accept' }],
    },
    {
      version: 1,
      interactionId: 'elicitation-1',
      kind: 'elicitation',
      mode: 'url',
      owner: { ...owner, invocationId: 'inv-elicitation' },
      provider: { ...provider, method: 'mcpServer/elicitation/request', requestId: 3 },
      createdAt: 8,
      title: 'Authorize provider',
      message: 'Open the provider page',
      elicitationId: 'elicit-1',
      url: 'https://example.com/auth',
      decisions: [{ id: 'cancel', label: 'Cancel', outcome: 'cancel' }],
    },
  ];
  for (const request of [question, ...nonQuestions]) {
    await store.createStaged({ request, hostEpoch: 'host-1', now: request.createdAt });
    await store.anchor(
      request.interactionId,
      'host-1',
      {
        threadId: request.owner.threadId,
        messageId: `message-${request.interactionId}`,
        blockId: `card-${request.interactionId}`,
        ...(request.kind === 'question' ? { blockDigest: 'a'.repeat(64), publishedAt: request.createdAt } : {}),
      },
      request.interactionId === question.interactionId ? 20 : request.createdAt + 1,
    );
  }
  return store;
}

async function pendingQuestionRecord(): Promise<RuntimeInteractionRecord> {
  const records = await (await populatedStore()).listPendingByUser('owner');
  const record = records.find((candidate) => candidate.request.interactionId === question.interactionId);
  assert.ok(record);
  return record;
}

test('the owner pending index projects approval, question and elicitation exactly once', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const store = await populatedStore();
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  let linked = true;
  app.get('/api/entrusted-work/needs-me', async () => ({
    ownerReads: linked ? [work([receipt('choice-1', 'f306.runtime_interaction', 20)])] : [],
    coverage: { state: 'complete' },
  }));
  const read = () =>
    readCompanionDecisionProjection(app, 'owner', { offset: 0, limit: 20 }, undefined, undefined, store);

  const pending = await read();
  assert.equal(pending.status, 'available');
  assert.equal(pending.sources.structuredChoices?.exhaustiveness, 'complete');
  assert.equal(pending.totalCount, 3, 'the Task-linked receipt and canonical question are one decision');
  assert.equal(pending.attentionCount, 3);
  assert.deepEqual(
    pending.items.map((item) =>
      (item as typeof item & { runtimeInteraction?: { interactionId: string; kind: string } }).runtimeInteraction
        ? {
            interactionId: (item as typeof item & { runtimeInteraction: { interactionId: string; kind: string } })
              .runtimeInteraction.interactionId,
            kind: (item as typeof item & { runtimeInteraction: { interactionId: string; kind: string } })
              .runtimeInteraction.kind,
          }
        : undefined,
    ),
    [
      { interactionId: 'choice-1', kind: 'question' },
      { interactionId: 'approval-1', kind: 'approval' },
      { interactionId: 'elicitation-1', kind: 'elicitation' },
    ],
  );
  const projectedQuestion = pending.items.find((item) => item.decisionRef === 'f306.runtime_interaction:choice-1');
  assert.equal(projectedQuestion?.choiceRequest?.interactionId, 'choice-1');
  assert.equal(projectedQuestion?.choiceRequest?.questions[0]?.question, 'Where should I run this?');
  assert.equal(unifiedAttentionChoiceRequestSchema.safeParse(projectedQuestion?.choiceRequest).success, true);
  assert.deepEqual(projectedQuestion?.choiceRequest?.cardRef, projectedQuestion?.runtimeInteraction?.cardRef);
  assert.equal(projectedQuestion?.choiceRequest?.cardRef.blockDigest, 'a'.repeat(64));
  assert.equal(projectedQuestion?.linkedNeedsMe.length, 1);

  await store.settle({
    interactionId: 'choice-1',
    hostEpoch: 'host-1',
    terminal: { status: 'answered', reasonCode: 'answered', settledAt: 30 },
    now: 30,
  });
  linked = false;
  const answered = await read();
  assert.equal(answered.totalCount, 2);
  assert.equal(answered.attentionCount, 2);
  assert.deepEqual(
    answered.items.map((item) => item.decisionRef),
    ['f306.runtime_interaction:approval-1', 'f306.runtime_interaction:elicitation-1'],
  );
});

test('an exact F306 approval alias merges only on owner, requester, card and revision', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const exact = {
    ...approval('approval-1', 'F306'),
    requesterCatId: owner.catId,
    navigation: {
      state: 'anchored' as const,
      originRef: { kind: 'message' as const, threadId: owner.threadId, messageId: 'message-approval-1' },
      approvalCardRef: { threadId: owner.threadId, messageId: 'message-approval-1' },
    },
    needsMeDecisionRefs: [{ producerId: 'f306.runtime_interaction' as const, subjectRef: 'approval-1', revision: 10 }],
  };
  let row = exact;
  app.get('/api/approval-hub/pending', async () => ({ items: [row], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const store = await populatedStore();

  const merged = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    store,
  );
  assert.equal(merged.totalCount, 3);
  assert.equal(merged.items.filter((item) => item.decisionRef === 'f306.runtime_interaction:approval-1').length, 1);
  assert.equal(
    (
      merged.items.find((item) => item.decisionRef === 'f306.runtime_interaction:approval-1') as
        | ((typeof merged.items)[number] & { runtimeInteraction?: { kind: string } })
        | undefined
    )?.runtimeInteraction?.kind,
    'approval',
  );

  row = {
    ...exact,
    needsMeDecisionRefs: [{ producerId: 'f306.runtime_interaction' as const, subjectRef: 'approval-1', revision: 11 }],
  };
  const conflict = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    store,
  );
  assert.equal(conflict.totalCount, undefined);
  assert.equal(conflict.attentionCount, undefined);
  assert.equal(conflict.items.filter((item) => item.decisionRef === 'f306.runtime_interaction:approval-1').length, 2);
  assert.ok(conflict.consistency.reasons.includes('producer_version_or_link_unverified'));
});

test('an unavailable structured-choice source withholds every exact attention count', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [approval('known')], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const unavailableStore = { listPendingByUser: async () => Promise.reject(new Error('choice source unavailable')) };
  const result = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    unavailableStore,
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.sources.structuredChoices?.status, 'unavailable');
  assert.equal(result.items.length, 1);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.attentionCount, undefined);
});

for (const [name, batch] of [
  ['a Redis detail command failure', [[new Error('WRONGTYPE detail hash'), null]]],
  ['a pending index entry with no detail', [[null, {}]]],
  ['a Redis batch with no results', null],
] as const) {
  test(`${name} keeps the source partial instead of certifying zero`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
    app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
    const redis = {
      zrevrange: async () => ['choice-1'],
      multi: () => ({ hgetall: () => undefined, exec: async () => batch }),
    };

    const result = await readCompanionDecisionProjection(
      app,
      'owner',
      { offset: 0, limit: 20 },
      undefined,
      undefined,
      new RedisRuntimeInteractionStore(redis as never),
    );
    assert.equal(result.status, 'partial');
    assert.equal(result.sources.structuredChoices?.exhaustiveness, 'partial');
    assert.equal(result.totalCount, undefined);
    assert.equal(result.attentionCount, undefined);
  });
}

test('a terminal record observed after pending-index enumeration is complete evidence of retirement', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const terminal = {
    ...(await pendingQuestionRecord()),
    status: 'answered' as const,
    terminal: { status: 'answered' as const, reasonCode: 'answered' as const, settledAt: 30 },
    updatedAt: 30,
  };
  const source = {
    listPendingByUser: async () => [],
    readPendingIndexByUser: async () => ({ records: [terminal], exhaustiveness: 'complete' as const }),
  };

  const result = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    source,
  );
  assert.equal(result.status, 'available');
  assert.equal(result.totalCount, 0);
  assert.equal(result.attentionCount, 0);
});

test('a Task-linked question at a conflicting producer revision stays visible but withholds exact counts', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({
    ownerReads: [work([receipt('choice-1', 'f306.runtime_interaction', 19)])],
    coverage: { state: 'complete' },
  }));

  const result = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    await populatedStore(),
  );
  assert.equal(result.status, 'available');
  assert.equal(result.consistency.state, 'uncertain');
  assert.ok(result.consistency.reasons.includes('producer_version_or_link_unverified'));
  assert.equal(
    result.items.filter((item) => item.decisionRef === 'f306.runtime_interaction:choice-1').length,
    2,
    'conflicting revisions remain separate evidence instead of false dedupe',
  );
  assert.equal(result.items.length, 4, 'the other two pending runtime kinds remain visible');
  assert.equal(result.totalCount, undefined);
  assert.equal(result.attentionCount, undefined);
});

test('a same-revision question with a conflicting canonical Task remains separate and withholds counts', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({
    ownerReads: [work([receipt('choice-1', 'f306.runtime_interaction', 20)])],
    coverage: { state: 'complete' },
  }));
  const record = await pendingQuestionRecord();
  const conflicting = {
    ...record,
    request: {
      ...record.request,
      entrustedWorkTaskRef: { subjectRef: 'task:work:another', observedRevision: 7 },
    },
  } satisfies RuntimeInteractionRecord;
  const source = {
    listPendingByUser: async () => [conflicting],
    readPendingIndexByUser: async () => ({ records: [conflicting], exhaustiveness: 'complete' as const }),
  };

  const result = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    source,
  );
  assert.equal(result.consistency.state, 'uncertain');
  assert.equal(result.items.length, 2);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.attentionCount, undefined);
});

test('a question card outside the canonical owner thread invalidates the structured-choice source', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const record = await pendingQuestionRecord();
  assert.ok(record.cardRef);
  const conflicting = {
    ...record,
    cardRef: { ...record.cardRef, threadId: 'foreign-thread' },
  } satisfies RuntimeInteractionRecord;
  const source = {
    listPendingByUser: async () => [conflicting],
    readPendingIndexByUser: async () => ({ records: [conflicting], exhaustiveness: 'complete' as const }),
  };

  const result = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    source,
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.sources.structuredChoices?.status, 'invalid');
  assert.equal(result.totalCount, undefined);
  assert.equal(result.attentionCount, undefined);
});

test('decision-qualified count includes open approvals and native questions, but not an eligible repair', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({
    items: [approval('approve-me', 'F139')],
    coverage: { state: 'complete' },
  }));
  app.get('/api/entrusted-work/needs-me', async () => ({
    ownerReads: [work([{ ...receipt('repair-me', 'f292.repair', 5), kind: 'repair' }])],
    coverage: { state: 'complete' },
  }));

  const result = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    await populatedStore(),
  );
  assert.equal(result.totalCount, 5);
  assert.equal(result.attentionCount, 4);
  assert.deepEqual(result.items.map((item) => item.kind).sort(), [
    'approval',
    'judgment',
    'judgment',
    'judgment',
    'repair',
  ]);

  const paged = await readCompanionDecisionProjection(
    app,
    'owner',
    { offset: 0, limit: 1 },
    undefined,
    undefined,
    await populatedStore(),
  );
  assert.equal(paged.items.length, 1);
  assert.equal(paged.page.hasMore, true);
  assert.equal(paged.totalCount, 5, 'totalCount remains full-source, not current-page length');
  assert.equal(paged.attentionCount, 4, 'decision-qualified count remains full-source, not current-page length');
});

test('the callback consumer reads the same structured-choice source and exact count', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/callbacks/companion/')) {
      request.callbackAuth = { userId: 'owner' } as NonNullable<typeof request.callbackAuth>;
    }
  });
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  registerCompanionWorkReadRoutes(app, '/current', await populatedStore());

  const response = await app.inject('/api/callbacks/companion/decisions?view=unified');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().attentionCount, 3);
  assert.equal(response.json().items[0]?.choiceRequest.interactionId, 'choice-1');
});
