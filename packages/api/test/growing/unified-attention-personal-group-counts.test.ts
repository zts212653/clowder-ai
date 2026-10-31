import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IgnoredItemSnapshot,
  UnifiedAttentionItemV1,
  UnifiedAttentionReadV1,
  UnifiedAttentionSourceRead,
} from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { projectCompanionDecisions } from '../../src/routes/companion-decision-projection.js';
import { companionDecisionRoutes } from '../../src/routes/companion-decision-routes.js';
import type { UserMentionTodoRead } from '../../src/routes/user-mention-todo-projection.js';
import { approval, receipt, work } from './unified-attention-fixtures.js';

const source = (coverage: UnifiedAttentionSourceRead['coverage']): UnifiedAttentionSourceRead => ({
  status: 'available',
  exhaustiveness: 'complete',
  startedAt: 1,
  observedAt: 2,
  coverage,
});

type PersonalInput = {
  mode: 'visible' | 'ignored';
  snapshot?: IgnoredItemSnapshot;
  state: UnifiedAttentionSourceRead;
};

function project(
  personal: PersonalInput | undefined,
  mentions: UserMentionTodoRead,
  works: ReturnType<typeof work>[],
  page = { offset: 0, limit: 20 },
): UnifiedAttentionReadV1 {
  return projectCompanionDecisions(
    { items: [approval('decision')], coverage: { state: 'complete' } },
    { ownerReads: works, coverage: { state: 'complete' } },
    'owner',
    page,
    3,
    {
      approvals: source('all_registered_F246_producers'),
      needsMe: source('current_linked_F310_five_producers'),
      structuredChoices: source('pending_f306_structured_choices'),
    },
    mentions,
    [],
    personal,
  );
}

function coordinate(item: UnifiedAttentionItemV1) {
  assert.ok(item.preferenceCoordinate, `missing preference coordinate for ${item.decisionRef}`);
  return item.preferenceCoordinate;
}

test('personal group counts describe the complete selected vector before paging and for every partition', () => {
  const mentions: UserMentionTodoRead = {
    items: Array.from({ length: 26 }, (_, index) => ({
      decisionRef: `user-mention:thread-${index}`,
      kind: 'user_mention' as const,
      summary: `Mention ${index}`,
      userMention: {
        threadId: `thread-${index}`,
        messageId: `message-${index}`,
        expectedRevision: index + 1,
        catId: 'codex61-sol',
        content: `@you request ${index}`,
        timestamp: 100 + index,
      },
      linkedNeedsMe: [],
    })),
    period: 'week',
    counts: { today: 26, week: 26, earlier: 0, handled: 0 },
    state: source('explicit_user_mentions'),
  };
  const otherWork = work([receipt('plain-judgment'), { ...receipt('repair', 'f292.repair'), kind: 'repair' as const }]);
  const original = project(undefined, mentions, [otherWork], { offset: 0, limit: 100 });
  const decision = original.items.find((item) => item.approval?.resolution === 'open');
  const repair = original.items.find((item) => item.kind === 'repair');
  const ignoredMentions = original.items.filter((item) => item.kind === 'user_mention').slice(0, 20);
  assert.ok(decision);
  assert.ok(repair);
  const snapshot: IgnoredItemSnapshot = {
    ownerUserId: 'owner',
    revision: 7,
    entries: [decision, repair, ...ignoredMentions].map((item, index) => ({
      coordinate: coordinate(item),
      ignoredAt: 200 + index,
    })),
  };

  const visible = project({ mode: 'visible', snapshot, state: source('owner_personal_ignored_items') }, mentions, [
    otherWork,
  ]);
  assert.equal(visible.items.length, 7);
  assert.deepEqual(visible.personalView?.groupCounts, {
    original: { decisions: 1, userMentions: 26, other: 2 },
    visible: { decisions: 0, userMentions: 6, other: 1 },
    ignored: { decisions: 1, userMentions: 20, other: 1 },
  });

  const ignored = project({ mode: 'ignored', snapshot, state: source('owner_personal_ignored_items') }, mentions, [
    otherWork,
  ]);
  assert.equal(ignored.totalCount, 22);
  assert.equal(ignored.items.length, 20);
  assert.equal(ignored.page.hasMore, true);
  assert.deepEqual(ignored.personalView?.groupCounts, visible.personalView?.groupCounts);
});

test('only an exact named F309 content-review receipt is decision-qualified', () => {
  const mentions: UserMentionTodoRead = {
    items: [],
    period: 'week',
    counts: { today: 0, week: 0, earlier: 0, handled: 0 },
    state: source('explicit_user_mentions'),
  };
  const exact = {
    ...receipt('review-one', 'f309.content_review', 4),
    reasonCode: 'content_review_requested',
    salience: 'normal' as const,
    producer: {
      producerId: 'f309.content_review',
      ownerRef: 'content-review:review-one',
      subjectRef: 'review-one',
      revision: 4,
    },
    action: { actionRef: 'content-review:review-one', expectedProducerRevision: 4 },
    reEvaluateActionRef: 'content-review:review-one#reevaluate',
  };
  const exactResult = project(undefined, mentions, [work([exact])]);
  assert.equal(exactResult.attentionCount, 2, 'the approval and named review both await a decision');
  assert.deepEqual(exactResult.personalView, undefined);
  assert.equal(
    exactResult.items.find((item) => item.decisionRef === 'f309.content_review:review-one')?.kind,
    'judgment',
  );

  const unnamed = project(undefined, mentions, [work([receipt('review-two', 'f309.content_review', 4)])]);
  assert.equal(unnamed.attentionCount, 1, 'an untyped lookalike judgment remains other');
});

test('the owner route returns exact group counts for a full vector larger than its 20-row page', async (t) => {
  const now = new Date(2026, 9, 13, 10).getTime();
  const store = new MessageStore();
  store.initializeUserMentionInbox(now - 7 * 86_400_000);
  for (let index = 0; index < 26; index++) {
    store.append({
      userId: 'owner',
      from: { kind: 'agent', catId: 'codex61-sol' },
      threadId: `thread-${index}`,
      content: `@co-creator request ${index}`,
      mentions: [],
      mentionsUser: true,
      timestamp: now - index,
    });
  }
  const otherWork = work([receipt('plain-judgment'), { ...receipt('repair', 'f292.repair'), kind: 'repair' as const }]);
  const app = Fastify();
  t.after(() => app.close());
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner';
  });
  app.get('/api/approval-hub/pending', async () => ({
    items: [approval('decision', 'F139')],
    coverage: { state: 'complete' },
  }));
  app.get('/api/entrusted-work/needs-me', async () => ({
    ownerReads: [otherWork],
    coverage: { state: 'complete' },
  }));
  await app.register(companionDecisionRoutes, {
    ownerUserId: 'owner',
    messageStore: store,
    runtimeInteractionStore: {
      listPendingByUser: async () => [],
      readPendingIndexByUser: async () => ({ records: [], exhaustiveness: 'complete' }),
    },
    now: () => now,
    readIgnoredItemPreferences: () => ({ ownerUserId: 'owner', revision: 7, entries: [] }),
  });

  const response = await app.inject(
    '/api/concierge/work/decisions?view=unified&includeUserMentions=true&mentionPeriod=week&limit=20&personalView=visible',
  );
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.items.length, 20);
  assert.equal(body.totalCount, 29);
  assert.equal(body.page.hasMore, true);
  assert.deepEqual(body.personalView.groupCounts, {
    original: { decisions: 1, userMentions: 26, other: 2 },
    visible: { decisions: 1, userMentions: 26, other: 2 },
    ignored: { decisions: 0, userMentions: 0, other: 0 },
  });
});
