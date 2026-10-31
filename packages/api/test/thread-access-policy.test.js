import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ACCESS_REQUESTS = [
  { resource: 'sessions', action: 'list' },
  { resource: 'transcript', action: 'read' },
  { resource: 'invocations', action: 'read' },
  { resource: 'theater', action: 'replay' },
  { resource: 'executions', action: 'read' },
  { resource: 'executions', action: 'cancel' },
];

describe('F299 thread access policy', () => {
  it('owns the explicit identity × resource × action read matrix', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { resolveThreadAccess } = await import('../dist/domains/cats/services/session/thread-access-policy.js');
    const threadStore = new ThreadStore();
    const userThread = await threadStore.create('owner-user', 'owner thread');
    const indexedSystemThread = await threadStore.ensureThread('thread_eval_friction', 'Eval friction');
    const unindexedSystemThread = await threadStore.ensureThread('thread_system_private', 'Private system thread');
    const defaultThread = await threadStore.get('default');
    const externalAnchorThread = await threadStore.ensureExternalRuntimeAnchorThread(
      'antigravity-desktop',
      'anchor-user',
    );
    await threadStore.indexForUser(indexedSystemThread.id, 'indexed-user');

    const cases = [
      { name: 'owner reads user thread', thread: userThread, userId: 'owner-user', status: 200, scope: 'thread' },
      { name: 'non-owner reads user thread', thread: userThread, userId: 'other-user', status: 403 },
      {
        name: 'any user reads shared default',
        thread: defaultThread,
        userId: 'other-user',
        status: 200,
        scope: 'user',
      },
      {
        name: 'indexed user reads indexed system thread',
        thread: indexedSystemThread,
        userId: 'indexed-user',
        status: 200,
        scope: 'user',
      },
      {
        name: 'non-indexed user cannot read indexed system thread',
        thread: indexedSystemThread,
        userId: 'other-user',
        status: 403,
      },
      {
        name: 'user cannot read unindexed system thread',
        thread: unindexedSystemThread,
        userId: 'indexed-user',
        status: 403,
      },
      {
        name: 'anchor owner reads external runtime anchor',
        thread: externalAnchorThread,
        userId: 'anchor-user',
        status: 200,
        scope: 'user',
      },
      {
        name: 'foreign user cannot read external runtime anchor',
        thread: externalAnchorThread,
        userId: 'other-user',
        status: 403,
      },
    ];

    for (const testCase of cases) {
      for (const request of ACCESS_REQUESTS) {
        const decision = await resolveThreadAccess({
          threadStore,
          thread: testCase.thread,
          userId: testCase.userId,
          request,
        });
        assert.equal(decision.status, testCase.status, `${testCase.name}: ${request.resource}:${request.action}`);
        if (testCase.status === 200) {
          assert.equal(decision.scope, testCase.scope, `${testCase.name}: ${request.resource}:${request.action}`);
        }
      }
    }
  });

  it('filters shared and indexed system-thread records to the current user', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { filterThreadRecords, resolveThreadAccess } = await import(
      '../dist/domains/cats/services/session/thread-access-policy.js'
    );
    const threadStore = new ThreadStore();
    const thread = await threadStore.ensureThread('thread_eval_friction', 'Eval friction');
    await threadStore.indexForUser(thread.id, 'owner-user');
    const decision = await resolveThreadAccess({
      threadStore,
      thread,
      userId: 'owner-user',
      request: { resource: 'sessions', action: 'list' },
    });

    assert.equal(decision.status, 200);
    assert.deepEqual(
      filterThreadRecords(decision, [
        { id: 'mine', userId: 'owner-user' },
        { id: 'theirs', userId: 'other-user' },
      ]).map((record) => record.id),
      ['mine'],
    );
  });
});
