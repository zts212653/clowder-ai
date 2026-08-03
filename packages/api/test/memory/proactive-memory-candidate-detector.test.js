import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

describe('ProactiveMemoryCandidateDetector', () => {
  let MessageStore;
  let ProactiveMemoryCandidateDetector;
  let messageStore;
  let threads;
  let threadStore;

  before(async () => {
    ({ MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ ProactiveMemoryCandidateDetector } = await import(
      '../../dist/domains/memory/ProactiveMemoryCandidateDetector.js'
    ));
  });

  beforeEach(() => {
    messageStore = new MessageStore();
    threads = new Map();
    threadStore = { get: (threadId) => threads.get(threadId) ?? null };
  });

  function addThread(threadId, overrides = {}) {
    threads.set(threadId, {
      id: threadId,
      projectPath: '/workspace',
      title: threadId,
      createdBy: 'owner-1',
      participants: [],
      lastActiveAt: 1,
      createdAt: 1,
      ...overrides,
    });
  }

  function append(content, threadId, timestamp, overrides = {}) {
    return messageStore.append({
      userId: 'owner-1',
      catId: null,
      content,
      mentions: [],
      threadId,
      timestamp,
      ...overrides,
    });
  }

  function detector(overrides = {}) {
    return new ProactiveMemoryCandidateDetector(messageStore, threadStore, {
      windowMs: 1_000,
      recentWindowMs: 100,
      minDistinctThreads: 2,
      minDistinctMessages: 3,
      minBackgroundMessages: 4,
      minRecentBurstLift: 2,
      maxNudgesPerTurn: 3,
      ...overrides,
    });
  }

  it('surfaces Alden across two public threads as lane-neutral statistical facts', async () => {
    addThread('thread-a');
    addThread('thread-b');
    const first = append('Alden', 'thread-a', 100);
    const second = append('Alden', 'thread-b', 200);
    const current = append('Alden', 'thread-b', 300);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 300,
    });

    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      phrase: 'Alden',
      normalizedPhrase: 'alden',
      window: { sinceInclusive: 0, untilInclusive: 300 },
      distinctThreadCount: 2,
      distinctMessageCount: 3,
      messageShare: 1,
      frequency: {
        background: {
          untilExclusive: 200,
          eligibleMessageCount: 1,
          distinctMessageCount: 1,
          messageShare: 1,
        },
        recentBurst: {
          sinceInclusive: 200,
          eligibleMessageCount: 2,
          distinctMessageCount: 2,
          messageShare: 1,
        },
      },
      sourceCoordinates: [
        { threadId: 'thread-a', messageIds: [first.id] },
        { threadId: 'thread-b', messageIds: [second.id, current.id] },
      ],
    });
    for (const forbidden of ['lane', 'importance', 'recommendation', 'toolPayload']) {
      assert.equal(Object.hasOwn(result[0], forbidden), false);
    }
  });

  it('does not surface a phrase confined to one thread even after ten messages', async () => {
    addThread('thread-a');
    let current;
    for (let timestamp = 1; timestamp <= 10; timestamp += 1) {
      current = append('Alden', 'thread-a', timestamp);
    }

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 10,
    });
    assert.deepEqual(result, []);
  });

  it('never combines another owner into the occurrence threshold', async () => {
    addThread('thread-a');
    addThread('thread-b');
    append('Alden', 'thread-a', 100);
    const current = append('Alden', 'thread-b', 200);
    append('Alden', 'thread-a', 150, { userId: 'owner-2' });

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 200,
    });
    assert.deepEqual(result, []);
  });

  it('filters private, whisper, connector, deleted, and unknown-thread sources before extraction', async () => {
    addThread('thread-public-a');
    addThread('thread-public-b');
    addThread('thread-private', { threadMetadata: { v: 1, notes: { privacy: 'private' } } });
    addThread('thread-whisper');
    addThread('thread-connector');
    addThread('thread-deleted', { deletedAt: 1 });
    addThread('thread-message-deleted');

    append('Alden', 'thread-public-a', 100);
    const current = append('Alden', 'thread-public-b', 200);
    append('Alden', 'thread-private', 210);
    append('Alden', 'thread-whisper', 220, { visibility: 'whisper' });
    append('Alden', 'thread-connector', 230, { source: { provider: 'feishu', externalMessageId: 'ext-1' } });
    append('Alden', 'thread-deleted', 235);
    const deleted = append('Alden', 'thread-message-deleted', 240);
    messageStore.softDelete(deleted.id, 'owner-1');
    append('Alden', 'thread-unknown', 250);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 250,
    });
    assert.deepEqual(result, []);
  });

  it('removes fixture-backed common phrases while keeping Alden', async () => {
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) addThread(threadId);
    append('公司，项目，昨天，Alden', 'thread-a', 100);
    append('公司，项目，昨天，Alden', 'thread-b', 200);
    const current = append('公司，项目，昨天，Alden', 'thread-c', 300);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 300,
    });
    assert.deepEqual(
      result.map((candidate) => candidate.normalizedPhrase),
      ['alden'],
    );
  });

  it('removes observed lexical fragments and code or ordinary nouns without assigning a lane', async () => {
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) addThread(threadId);
    const noise = 'App，commit，我希望，而言，成本，代码，会议';
    append(noise, 'thread-a', 100);
    append(noise, 'thread-b', 200);
    const current = append(noise, 'thread-c', 300);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 300,
    });

    assert.deepEqual(result, []);
  });

  it('suppresses a chronic background-frequency fallback with no recent lift', async () => {
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) addThread(threadId);
    append('Mingle', 'thread-a', 100);
    append('Mingle', 'thread-b', 200);
    append('Mingle', 'thread-a', 300);
    append('Mingle', 'thread-b', 400);
    append('Mingle', 'thread-a', 910);
    append('Mingle', 'thread-b', 950);
    const current = append('Mingle', 'thread-c', 1_000);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 1_000,
    });

    assert.deepEqual(result, []);
  });

  it('admits a recent cross-thread burst and exposes only lane-neutral background statistics', async () => {
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) addThread(threadId);
    append('公司', 'thread-a', 100);
    append('项目', 'thread-b', 200);
    append('昨天', 'thread-a', 300);
    append('会议', 'thread-b', 400);
    append('Alden', 'thread-a', 910);
    append('Alden', 'thread-b', 950);
    const current = append('Alden', 'thread-c', 1_000);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 1_000,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].normalizedPhrase, 'alden');
    assert.deepEqual(result[0].frequency, {
      background: {
        untilExclusive: 900,
        eligibleMessageCount: 4,
        distinctMessageCount: 0,
        messageShare: 0,
      },
      recentBurst: {
        sinceInclusive: 900,
        eligibleMessageCount: 3,
        distinctMessageCount: 3,
        messageShare: 1,
      },
    });
    for (const forbidden of ['lane', 'importance', 'recommendation', 'proposalAction']) {
      assert.equal(Object.hasOwn(result[0].frequency, forbidden), false);
    }
  });

  it('orders equal-share candidates by distinct thread specificity', async () => {
    for (const threadId of ['thread-a', 'thread-b', 'thread-c']) addThread(threadId);
    append('Alden，Boreal', 'thread-a', 100);
    append('Alden，Boreal', 'thread-b', 200);
    const current = append('Alden', 'thread-b', 250);
    append('Boreal', 'thread-c', 240);

    const result = await detector().detect({
      ownerUserId: 'owner-1',
      currentUserMessageId: current.id,
      now: 250,
    });
    assert.deepEqual(
      result.map((candidate) => [candidate.normalizedPhrase, candidate.distinctThreadCount]),
      [
        ['boreal', 3],
        ['alden', 2],
      ],
    );
  });

  it('rebuilds from current delete/restore and thread privacy truth without ghost counts', async () => {
    addThread('thread-a');
    addThread('thread-b');
    const first = append('Alden', 'thread-a', 100);
    append('Alden', 'thread-b', 200);
    const current = append('Alden', 'thread-b', 300);
    const input = { ownerUserId: 'owner-1', currentUserMessageId: current.id, now: 300 };

    assert.equal((await detector().detect(input)).length, 1);
    messageStore.softDelete(first.id, 'owner-1');
    assert.deepEqual(await detector().detect(input), []);
    messageStore.restore(first.id);
    assert.equal((await detector().detect(input)).length, 1);

    threads.get('thread-a').threadMetadata = { v: 1, notes: { privacy: 'private' } };
    assert.deepEqual(await detector().detect(input), []);
    delete threads.get('thread-a').threadMetadata;
    assert.equal((await detector().detect(input)).length, 1);
  });

  it('fails closed when the durable current message is absent or ineligible', async () => {
    addThread('thread-a');
    addThread('thread-b');
    append('Alden', 'thread-a', 100);
    append('Alden', 'thread-b', 200);
    const whisper = append('Alden', 'thread-b', 300, { visibility: 'whisper' });

    assert.deepEqual(
      await detector().detect({
        ownerUserId: 'owner-1',
        currentUserMessageId: 'missing-message',
        now: 300,
      }),
      [],
    );
    assert.deepEqual(
      await detector().detect({
        ownerUserId: 'owner-1',
        currentUserMessageId: whisper.id,
        now: 300,
      }),
      [],
    );
  });
});
