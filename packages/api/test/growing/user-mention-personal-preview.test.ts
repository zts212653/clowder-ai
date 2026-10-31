import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IgnoredItemSnapshot } from '@cat-cafe/shared';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { readUserMentionPersonalPreview } from '../../src/routes/user-mention-personal-preview.js';

const request = {
  userId: 'owner',
  from: { kind: 'agent' as const, catId: 'codex61-sol' },
  threadId: 'thread',
  content: '@co-creator\n请重启',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
};

test('personal mention preview is full-set, versioned, period-exact and fails closed without changing legacy preview', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { companionDecisionRoutes } = await import('../../src/routes/companion-decision-routes.js');
  const app = Fastify();
  t.after(() => app.close());

  const now = new Date(2026, 9, 12, 12).getTime();
  const cutover = now - 7 * 86_400_000;
  const store = new MessageStore();
  store.initializeUserMentionInbox(cutover);
  const today = store.append({ ...request, threadId: 'today', timestamp: now - 3_600_000 });
  store.append({ ...request, threadId: 'week', timestamp: now - 2 * 86_400_000 });
  store.append({ ...request, threadId: 'earlier', timestamp: now - 8 * 86_400_000 });

  const listRequests = store.listUserMentionRequests.bind(store);
  const readRevisions = store.getUserMentionStateRevisions.bind(store);
  let sourceFails = false;
  let revisionMissing = false;
  store.listUserMentionRequests = (ownerUserId) => {
    if (sourceFails) throw new Error('mention source unavailable');
    return listRequests(ownerUserId);
  };
  store.getUserMentionStateRevisions = (ownerUserId) => {
    const revisions = readRevisions(ownerUserId);
    if (revisionMissing) delete revisions.today;
    return revisions;
  };

  let preferenceFails = false;
  let preferences: IgnoredItemSnapshot = { ownerUserId: 'owner', revision: 0, entries: [] };
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  t.after(() => {
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  });
  app.addHook('preHandler', async (incoming) => {
    incoming.sessionUserId = String(incoming.headers['x-test-session'] ?? '');
  });
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  await app.register(companionDecisionRoutes, {
    ownerUserId: 'owner',
    messageStore: store,
    runtimeInteractionStore: {
      listPendingByUser: async () => [],
      readPendingIndexByUser: async () => ({ records: [], exhaustiveness: 'complete' }),
    },
    now: () => now,
    readIgnoredItemPreferences: (ownerUserId) => {
      assert.equal(ownerUserId, 'owner');
      if (preferenceFails) throw new Error('preference unavailable');
      return preferences;
    },
  });

  const preview = async (period: 'today' | 'week' | 'earlier' | 'all', personal = true) =>
    app.inject({
      url: `/api/concierge/work/mentions/handling-preview?period=${period}${personal ? '&personalView=visible' : ''}`,
      headers: { 'x-test-session': 'owner' },
    });

  const legacy = await preview('all', false);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.json().requests.length, 3);
  assert.deepEqual(legacy.json().counts, { week: 2, earlier: 1 });
  assert.equal(legacy.json().coverage, undefined);
  assert.equal(legacy.json().personalView, undefined);
  assert.equal(legacy.json().requests[0].preferenceCoordinate, undefined);

  const complete = await preview('all');
  assert.equal(complete.statusCode, 200);
  assert.deepEqual(complete.json().coverage, { state: 'complete' });
  assert.deepEqual(complete.json().consistency, { state: 'verified', reasons: [] });
  assert.equal(complete.json().readWindow.consistency, 'independent_source_reads');
  assert.ok(complete.json().readWindow.endedAt >= complete.json().readWindow.startedAt);
  assert.deepEqual(complete.json().counts, { week: 2, earlier: 1 });
  assert.deepEqual(complete.json().personalView, {
    mode: 'visible',
    preferenceRevision: 0,
    originalCount: 3,
    visibleCount: 3,
    ignoredCount: 0,
  });
  assert.equal(complete.json().requests.length, 3);
  assert.ok(
    complete
      .json()
      .requests.every(
        (row: Record<string, unknown>) =>
          typeof row.preferenceCoordinate === 'object' &&
          row.preferenceCoordinate !== null &&
          (row.preferenceCoordinate as { kind?: unknown }).kind === 'mailbox',
      ),
  );

  const expectedByPeriod = { today: 1, week: 2, earlier: 1, all: 3 } as const;
  for (const [period, count] of Object.entries(expectedByPeriod)) {
    const response = await preview(period as keyof typeof expectedByPeriod);
    assert.equal(response.json().coverage.state, 'complete');
    assert.equal(response.json().personalView.originalCount, count, period);
    assert.equal(response.json().requests.length, count, period);
  }

  const decisionRead = await app.inject({
    url: '/api/concierge/work/decisions?view=unified&includeUserMentions=true&mentionPeriod=week&personalView=visible',
    headers: { 'x-test-session': 'owner' },
  });
  assert.equal(decisionRead.statusCode, 200);
  assert.deepEqual(decisionRead.json().personalView.groupCounts, {
    original: { decisions: 0, userMentions: 2, other: 0 },
    visible: { decisions: 0, userMentions: 2, other: 0 },
    ignored: { decisions: 0, userMentions: 0, other: 0 },
  });
  const decisionCoordinates = new Map(
    decisionRead
      .json()
      .items.map((item: { userMention: { messageId: string }; preferenceCoordinate: unknown }) => [
        item.userMention.messageId,
        item.preferenceCoordinate,
      ]),
  );
  for (const row of (await preview('week')).json().requests) {
    assert.deepEqual(row.preferenceCoordinate, decisionCoordinates.get(row.messageId));
  }

  const ignoredCoordinate = complete
    .json()
    .requests.find((row: { messageId: string }) => row.messageId === today.id).preferenceCoordinate;
  preferences = {
    ownerUserId: 'owner',
    revision: 1,
    entries: [{ coordinate: ignoredCoordinate, ignoredAt: now }],
  };
  const ignoredToday = await preview('today');
  assert.deepEqual(ignoredToday.json().personalView, {
    mode: 'visible',
    preferenceRevision: 1,
    originalCount: 1,
    visibleCount: 0,
    ignoredCount: 1,
  });
  assert.deepEqual(ignoredToday.json().requests, []);

  const newer = store.append({ ...request, threadId: 'today', timestamp: now + 1, content: '@co-creator\n新版本' });
  const refreshed = await preview('all');
  const refreshedToday = refreshed.json().requests.find((row: { messageId: string }) => row.messageId === newer.id);
  assert.ok(refreshedToday, 'a newer producer version becomes visible again');
  assert.notDeepEqual(refreshedToday.preferenceCoordinate, ignoredCoordinate);
  assert.equal(refreshed.json().personalView.ignoredCount, 0);

  preferences = { ownerUserId: 'other', revision: 2, entries: [] };
  const wrongOwner = await preview('all');
  assert.deepEqual(wrongOwner.json().coverage, { state: 'partial' });
  assert.deepEqual(wrongOwner.json().requests, []);
  assert.equal(wrongOwner.json().counts, undefined);
  assert.equal(wrongOwner.json().personalView.preferenceRevision, undefined);
  assert.ok(wrongOwner.json().consistency.reasons.includes('personal_preference_read_unverified'));

  preferences = { ownerUserId: 'owner', revision: 2, entries: [] };
  preferenceFails = true;
  const unavailablePreference = await preview('all');
  assert.equal(unavailablePreference.json().coverage.state, 'partial');
  assert.deepEqual(unavailablePreference.json().requests, []);
  const legacyWhilePreferenceFails = await preview('all', false);
  assert.equal(legacyWhilePreferenceFails.statusCode, 200);
  assert.equal(legacyWhilePreferenceFails.json().requests.length, 3);
  preferenceFails = false;

  sourceFails = true;
  const unavailableSource = await preview('all');
  assert.equal(unavailableSource.statusCode, 200);
  assert.deepEqual(unavailableSource.json().coverage, { state: 'partial' });
  assert.deepEqual(unavailableSource.json().requests, []);
  assert.ok(unavailableSource.json().consistency.reasons.includes('mention_source_unverified'));
  sourceFails = false;

  revisionMissing = true;
  const incompleteRevisionSource = await preview('all');
  assert.equal(incompleteRevisionSource.json().coverage.state, 'partial');
  assert.deepEqual(incompleteRevisionSource.json().requests, []);
  assert.ok(incompleteRevisionSource.json().consistency.reasons.includes('mention_source_unverified'));
  revisionMissing = false;

  assert.equal(
    (await app.inject('/api/concierge/work/mentions/handling-preview?period=all&personalView=visible')).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/concierge/work/mentions/handling-preview?period=all&personalView=visible',
        headers: { 'x-test-session': 'other' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/concierge/work/mentions/handling-preview?period=all&personalView=ignored',
        headers: { 'x-test-session': 'owner' },
      })
    ).statusCode,
    400,
  );
});

test('personal mention preview returns the complete set beyond the mailbox page boundary', async () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  const store = new MessageStore();
  store.initializeUserMentionInbox(now - 7 * 86_400_000);
  for (let index = 0; index < 26; index++) {
    store.append({ ...request, threadId: `thread-${index}`, timestamp: now + index });
  }
  const result = await readUserMentionPersonalPreview({
    ownerUserId: 'owner',
    period: 'all',
    cutover: now - 7 * 86_400_000,
    now,
    messageStore: store,
    readIgnoredItemPreferences: () => ({ ownerUserId: 'owner', revision: 7, entries: [] }),
  });
  assert.deepEqual(result.coverage, { state: 'complete' });
  assert.deepEqual(result.counts, { week: 26, earlier: 0 });
  assert.deepEqual(result.personalView, {
    mode: 'visible',
    preferenceRevision: 7,
    originalCount: 26,
    visibleCount: 26,
    ignoredCount: 0,
  });
  assert.equal(result.requests.length, 26);
  assert.equal(new Set(result.requests.map((row) => JSON.stringify(row.preferenceCoordinate))).size, 26);
});
