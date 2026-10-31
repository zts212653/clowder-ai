import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IgnoredItemSnapshot,
  UnifiedAttentionItemV1,
  UnifiedAttentionReadV1,
  UnifiedAttentionSourceRead,
} from '@cat-cafe/shared';
import Fastify from 'fastify';
import { attachDecisionPreferenceCoordinates } from '../../src/routes/companion-decision-personal-view.js';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';
import { companionDecisionRoutes } from '../../src/routes/companion-decision-routes.js';
import type { UserMentionTodoRead } from '../../src/routes/user-mention-todo-projection.js';
import { approval } from './unified-attention-fixtures.js';

const source = (coverage: UnifiedAttentionSourceRead['coverage']): UnifiedAttentionSourceRead => ({
  status: 'available',
  exhaustiveness: 'complete',
  startedAt: 1,
  observedAt: 2,
  coverage,
});

const completeSources = {
  approvals: source('all_registered_F246_producers'),
  needsMe: source('current_linked_F310_five_producers'),
  structuredChoices: source('pending_f306_structured_choices'),
};

type PersonalInput = {
  mode: 'visible' | 'ignored';
  snapshot?: IgnoredItemSnapshot;
  state: UnifiedAttentionSourceRead;
};

function project(
  approvals: ReturnType<typeof approval>[],
  page = { offset: 0, limit: 20 },
  personal?: PersonalInput,
  mentions?: UserMentionTodoRead,
): UnifiedAttentionReadV1 {
  const call = projectCompanionDecisions as unknown as (
    approvalsSource: unknown,
    needsMeSource: unknown,
    userId: string,
    page: { offset: number; limit: number },
    observedAt: number,
    sourceReads: typeof completeSources,
    userMentions: UserMentionTodoRead | undefined,
    structuredChoices: [],
    personal: PersonalInput | undefined,
  ) => UnifiedAttentionReadV1;
  return call(
    { items: approvals, coverage: { state: 'complete' } },
    { ownerReads: [], coverage: { state: 'complete' } },
    'owner',
    page,
    3,
    completeSources,
    mentions,
    [],
    personal,
  );
}

function coordinate(item: UnifiedAttentionItemV1) {
  assert.ok(item.preferenceCoordinate, `missing preference coordinate for ${item.decisionRef}`);
  return item.preferenceCoordinate;
}

function preferences(entries: IgnoredItemSnapshot['entries']): IgnoredItemSnapshot {
  return { ownerUserId: 'owner', revision: 7, entries };
}

test('personal visibility filters the complete set before paging and publishes exact visible/ignored counts', () => {
  const approvals = Array.from({ length: 25 }, (_, index) => approval(`approval-${index}`));
  const original = project(approvals);
  const ignored = original.items.slice(0, 20).map((item, index) => ({
    coordinate: coordinate(item),
    ignoredAt: 100 + index,
  }));
  const visible = project(
    approvals,
    { offset: 0, limit: 20 },
    {
      mode: 'visible',
      snapshot: preferences(ignored),
      state: source('owner_personal_ignored_items'),
    },
  );

  assert.deepEqual(
    visible.items.map((item) => item.decisionRef),
    approvals.slice(20).map((item) => `approval:${item.sourceFeatureId}:${item.proposalId}`),
  );
  assert.equal(visible.page.hasMore, false);
  assert.equal(visible.totalCount, 5);
  assert.equal(visible.attentionCount, 5);
  assert.deepEqual(visible.personalView, {
    mode: 'visible',
    preferenceRevision: 7,
    originalTotalCount: 25,
    visibleTotalCount: 5,
    ignoredTotalCount: 20,
    originalAttentionCount: 25,
    visibleAttentionCount: 5,
    ignoredAttentionCount: 20,
    groupCounts: {
      original: { decisions: 25, userMentions: 0, other: 0 },
      visible: { decisions: 5, userMentions: 0, other: 0 },
      ignored: { decisions: 20, userMentions: 0, other: 0 },
    },
  });

  const ignoredPage = project(
    approvals,
    { offset: 0, limit: 7 },
    {
      mode: 'ignored',
      snapshot: preferences(ignored),
      state: source('owner_personal_ignored_items'),
    },
  );
  assert.equal(ignoredPage.items.length, 7);
  assert.equal(ignoredPage.page.hasMore, true);
  assert.equal(ignoredPage.totalCount, 20);
  assert.equal(ignoredPage.attentionCount, 20);
  assert.equal(ignoredPage.personalView?.visibleTotalCount, 5);
});

test('an old exact-version ignore never hides a changed approval', () => {
  const oldApproval = approval('versioned');
  const oldRead = project([oldApproval]);
  const oldItem = oldRead.items[0];
  assert.ok(oldItem);
  const snapshot = preferences([{ coordinate: coordinate(oldItem), ignoredAt: 100 }]);
  const changed = { ...oldApproval, summary: 'The producer changed the decision content' };
  const visible = project(
    [changed],
    { offset: 0, limit: 20 },
    {
      mode: 'visible',
      snapshot,
      state: source('owner_personal_ignored_items'),
    },
  );

  assert.equal(visible.items.length, 1);
  assert.equal(visible.items[0]?.summary, changed.summary);
  assert.equal(visible.personalView?.ignoredTotalCount, 0);
});

test('a structured choice coordinate uses its canonical interaction revision and card address', () => {
  const item: UnifiedAttentionItemV1 = {
    decisionRef: 'f306.runtime_interaction:choice-1',
    kind: 'judgment',
    summary: 'Choose an environment',
    choiceRequest: {
      interactionId: 'choice-1',
      revision: 5,
      requesterCatId: 'codex-sol',
      createdAt: 1,
      title: 'Environment',
      questions: [{ id: 'env', header: 'Environment', question: 'Where?' }],
      cardRef: { threadId: 'thread-1', messageId: 'message-1', blockId: 'block-1' },
    },
    linkedNeedsMe: [],
  };
  const originalItem = attachDecisionPreferenceCoordinates([item])[0];
  const sameVersionItem = attachDecisionPreferenceCoordinates([{ ...item, summary: 'Presentation copy changed' }])[0];
  assert.ok(originalItem);
  assert.ok(sameVersionItem);
  const original = coordinate(originalItem);
  const sameCanonicalVersion = coordinate(sameVersionItem);
  const choice = item.choiceRequest;
  assert.ok(choice);
  const nextRevisionItem = attachDecisionPreferenceCoordinates([
    { ...item, choiceRequest: { ...choice, revision: choice.revision + 1 } },
  ])[0];
  assert.ok(nextRevisionItem);
  const nextRevision = coordinate(nextRevisionItem);

  assert.equal(sameCanonicalVersion.version, original.version);
  assert.notEqual(nextRevision.version, original.version);
});

test('an approval/runtime alias binds Ignore to both exact proofs while preserving the legacy question version', () => {
  const baseApproval = approval('approval-1', 'F306');
  const runtime = {
    interactionId: 'approval-1',
    revision: 7,
    kind: 'approval' as const,
    requesterCatId: baseApproval.requesterCatId,
    createdAt: baseApproval.createdAt,
    title: baseApproval.summary,
    cardRef: { threadId: 'thread-1', messageId: 'message-1', blockId: 'block-1' },
  };
  const aliased = {
    decisionRef: 'f306.runtime_interaction:approval-1',
    kind: 'approval' as const,
    summary: baseApproval.summary,
    approval: baseApproval,
    runtimeInteraction: runtime,
    linkedNeedsMe: [],
  } as unknown as UnifiedAttentionItemV1;
  const first = coordinate(attachDecisionPreferenceCoordinates([aliased])[0]);
  const runtimeChanged = coordinate(
    attachDecisionPreferenceCoordinates([
      {
        ...aliased,
        runtimeInteraction: { ...runtime, revision: runtime.revision + 1 },
      } as unknown as UnifiedAttentionItemV1,
    ])[0],
  );
  const approvalChanged = coordinate(
    attachDecisionPreferenceCoordinates([
      {
        ...aliased,
        approval: { ...baseApproval, summary: 'Changed approval source' },
      } as unknown as UnifiedAttentionItemV1,
    ])[0],
  );
  assert.notEqual(runtimeChanged.version, first.version);
  assert.notEqual(approvalChanged.version, first.version);

  const question = {
    decisionRef: 'f306.runtime_interaction:question-1',
    kind: 'judgment' as const,
    summary: 'Where?',
    choiceRequest: {
      interactionId: 'question-1',
      revision: 5,
      requesterCatId: 'codex-sol',
      createdAt: 1,
      title: 'Question',
      questions: [{ id: 'q', header: 'Question', question: 'Where?' }],
      cardRef: { threadId: 'thread-1', messageId: 'message-2', blockId: 'block-2' },
    },
    linkedNeedsMe: [],
  } satisfies UnifiedAttentionItemV1;
  const legacy = coordinate(attachDecisionPreferenceCoordinates([question])[0]);
  const withRuntime = coordinate(
    attachDecisionPreferenceCoordinates([
      {
        ...question,
        runtimeInteraction: {
          interactionId: 'question-1',
          revision: 5,
          kind: 'question',
          requesterCatId: 'codex-sol',
          createdAt: 1,
          title: 'Question',
          cardRef: question.choiceRequest.cardRef,
        },
      } as unknown as UnifiedAttentionItemV1,
    ])[0],
  );
  assert.equal(withRuntime.version, legacy.version);
});

test('mention ignores never enter the decision badge and schedule preferences never suppress Needs Me', () => {
  const mentions: UserMentionTodoRead = {
    items: [
      {
        decisionRef: 'user-mention:thread-1',
        kind: 'user_mention',
        summary: '对话中的请求',
        userMention: {
          threadId: 'thread-1',
          messageId: 'message-1',
          expectedRevision: 3,
          catId: 'codex61-sol',
          content: '@你 看一下',
          timestamp: 10,
        },
        linkedNeedsMe: [],
      },
    ],
    period: 'week',
    counts: { today: 1, week: 1, earlier: 0, handled: 0 },
    state: source('explicit_user_mentions'),
  };
  const original = project([approval('decision')], { offset: 0, limit: 20 }, undefined, mentions);
  const mention = original.items.find((item) => item.kind === 'user_mention');
  assert.ok(mention);
  const snapshot = preferences([
    { coordinate: coordinate(mention), ignoredAt: 10 },
    { coordinate: { kind: 'schedule', subjectRef: 'approval:F221:decision' }, ignoredAt: 11 },
  ]);
  const visible = project(
    [approval('decision')],
    { offset: 0, limit: 20 },
    {
      mode: 'visible',
      snapshot,
      state: source('owner_personal_ignored_items'),
    },
    mentions,
  );

  assert.deepEqual(
    visible.items.map((item) => item.kind),
    ['approval'],
  );
  assert.equal(visible.attentionCount, 1);
  assert.equal(visible.personalView?.originalAttentionCount, 1);
  assert.equal(visible.personalView?.ignoredAttentionCount, 0);
});

test('a failed preference read fails the personal view closed without turning unknown into zero', () => {
  const unavailable: UnifiedAttentionSourceRead = {
    status: 'unavailable',
    exhaustiveness: 'unknown',
    startedAt: 1,
    observedAt: 2,
    coverage: 'owner_personal_ignored_items',
  };
  const result = project(
    [approval('decision')],
    { offset: 0, limit: 20 },
    {
      mode: 'visible',
      state: unavailable,
    },
  );

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.items, []);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.attentionCount, undefined);
  assert.equal(result.personalView?.preferenceRevision, undefined);
  assert.equal(result.personalView?.groupCounts, undefined);
  assert.equal(result.sources.personalPreferences?.status, 'unavailable');
});

test('the owner route reads preferences only for an explicit unified personal view', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner';
  });
  app.get('/api/approval-hub/pending', async () => ({
    items: [approval('route-a', 'F139'), approval('route-b', 'F139')],
    coverage: { state: 'complete' },
  }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  let snapshot = preferences([]);
  let reads = 0;
  let failRead = false;
  await app.register(companionDecisionRoutes, {
    ownerUserId: 'owner',
    collectiveAccountability: async () => ({
      status: 200,
      body: {
        data: {
          items: [],
          reasons: [],
          state: {
            coverage: 'pending_f290_collective_accountability_requests',
            status: 'available',
            exhaustiveness: 'complete',
            startedAt: 1,
            observedAt: 2,
          },
        },
      },
    }),
    readIgnoredItemPreferences(ownerUserId: string) {
      reads++;
      assert.equal(ownerUserId, 'owner');
      if (failRead) throw new Error('preference store unavailable');
      return snapshot;
    },
  });

  const canonical = await app.inject('/api/concierge/work/decisions?view=unified');
  assert.equal(canonical.statusCode, 200);
  assert.equal(reads, 0);
  const firstCoordinate = coordinate(canonical.json().items[0]);
  snapshot = preferences([{ coordinate: firstCoordinate, ignoredAt: 10 }]);

  assert.equal((await app.inject('/api/concierge/work/decisions?personalView=visible')).statusCode, 400);
  const visible = await app.inject('/api/concierge/work/decisions?view=unified&personalView=visible');
  assert.equal(visible.statusCode, 200);
  assert.equal(reads, 1);
  assert.equal(visible.json().items.length, 1);
  assert.equal(visible.json().personalView.ignoredTotalCount, 1);

  failRead = true;
  const unavailable = await app.inject('/api/concierge/work/decisions?view=unified&personalView=visible');
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.json().status, 'partial');
  assert.deepEqual(unavailable.json().items, []);
  assert.equal(unavailable.json().totalCount, undefined);
  assert.equal(unavailable.json().sources.personalPreferences.status, 'unavailable');
});
