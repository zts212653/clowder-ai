import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { saveMessageDispositionPreference } = await import('../dist/config/user-preferences-store.js');
const {
  resolveFreshnessCarrierCapabilityOrUndeclared,
  resolveMessageDispositionForAdmission,
  resolveQueueAuthorIntentByCatId,
} = await import('../dist/routes/message-disposition-admission.js');
const { sendMessageSchema } = await import('../dist/routes/messages.schema.js');

function entry(overrides = {}) {
  return {
    threadId: 'thread-1',
    userId: 'user-1',
    ownerAuthProvenance: 'strict',
    content: 'queued body',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  };
}

describe('F264 author-declared message disposition', () => {
  let queue;

  beforeEach(() => {
    queue = new InvocationQueue();
  });

  test('missing author intent is fail-closed next-work and never enters a live parent context', () => {
    queue.enqueue(entry());

    assert.deepEqual(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-a'), []);
    assert.deepEqual(
      queue.getQueuedFreshnessMessagesForCat('thread-1', 'user-1', 'opus', {
        parentInvocationId: 'parent-a',
      }),
      [],
    );
  });

  test('continue-current exposes the full body only to its exact bound parent', () => {
    const result = queue.enqueue(
      entry({
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: 'parent-a' },
        },
      }),
    );

    assert.equal(
      queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-a')[0]?.entryId,
      result.entry.id,
    );
    assert.deepEqual(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-b'), []);
    assert.deepEqual(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus'), []);
    assert.equal(
      queue.getQueuedFreshnessMessagesForCat('thread-1', 'user-1', 'opus', {
        parentInvocationId: 'parent-a',
      })[0]?.entryId,
      result.entry.id,
    );
  });

  test('current-parent exposure is source-domain aware and ignores author intent outside user messages', () => {
    const cases = [
      {
        name: 'legacy user without intent stays next-work',
        entry: entry({ content: 'legacy user', source: 'user' }),
        readable: false,
      },
      {
        name: 'user next-work stays isolated',
        entry: entry({
          content: 'user next work',
          source: 'user',
          authorIntentByCatId: { opus: { requested: 'next_work' } },
        }),
        readable: false,
      },
      {
        name: 'user continue-current requires its exact parent',
        entry: entry({
          content: 'user current work',
          source: 'user',
          authorIntentByCatId: {
            opus: { requested: 'continue_current', boundParentInvocationId: 'parent-a' },
          },
        }),
        readable: true,
      },
      {
        name: 'agent A2A remains readable without author intent',
        entry: entry({ content: 'agent custody', source: 'agent', sourceCategory: 'a2a' }),
        readable: true,
      },
      {
        name: 'connector event remains readable without author intent',
        entry: entry({ content: 'connector custody', source: 'connector', sourceCategory: 'review' }),
        readable: true,
      },
      {
        name: 'non-user custody ignores a stray next-work-shaped field',
        entry: entry({
          content: 'connector with polluted field',
          source: 'connector',
          sourceCategory: 'ci',
          authorIntentByCatId: { opus: { requested: 'next_work' } },
        }),
        readable: true,
      },
    ];

    for (const row of cases) {
      const isolated = new InvocationQueue();
      isolated.enqueue(row.entry);
      const body = isolated.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-a');
      const freshness = isolated.getQueuedFreshnessMessagesForCat('thread-1', 'user-1', 'opus', {
        parentInvocationId: 'parent-a',
      });
      assert.equal(body.length === 1, row.readable, `${row.name}: body exposure`);
      assert.equal(freshness.length === 1, row.readable, `${row.name}: freshness exposure`);
    }
  });

  test('an unread continue-current user message closes its parent window but stays eligible for successor work', () => {
    const result = queue.enqueue(
      entry({
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: 'parent-a' },
        },
      }),
    );

    assert.equal(
      queue.getQueuedFreshnessMessagesForCat('thread-1', 'user-1', 'opus', {
        parentInvocationId: 'parent-a',
      })[0]?.entryId,
      result.entry.id,
      'the active parent first owns the opportunity to read',
    );

    queue.fallbackAuthorIntentsForParentAcrossUsers('thread-1', 'opus', 'parent-a', 2_000);

    assert.deepEqual(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-a'), []);
    assert.equal(queue.peekNextQueued('thread-1', 'user-1')?.id, result.entry.id);
    assert.equal(queue.hasPendingForCat('thread-1', 'opus', { userId: 'user-1' }), true);
  });

  test('multi-target author intent remains target-local', () => {
    queue.enqueue(
      entry({
        targetCats: ['opus', 'codex-sol'],
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: 'parent-opus' },
          'codex-sol': { requested: 'next_work' },
        },
      }),
    );

    assert.equal(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-opus').length, 1);
    assert.deepEqual(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'codex-sol', 'parent-opus'), []);
  });

  test('admission binds continue-current only to each target exact live parent', () => {
    const authorIntentByCatId = resolveQueueAuthorIntentByCatId({
      targetCats: ['opus', 'codex-sol'],
      requested: 'continue_current',
      threadId: 'thread-1',
      userId: 'user-1',
      invocationTracker: {
        has: (_threadId, catId) => catId === 'opus',
        getUserId: (_threadId, catId) => (catId === 'opus' ? 'user-1' : null),
        getExecutionId: (_threadId, catId) => (catId === 'opus' ? 'parent-opus' : undefined),
      },
      resolveCarrierCapability: () => ({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      }),
      now: 1_000,
    });

    assert.deepEqual(authorIntentByCatId, {
      opus: {
        requested: 'continue_current',
        boundParentInvocationId: 'parent-opus',
        carrierCapability: {
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          deliverySemantics: 'exact_active_turn',
        },
      },
      'codex-sol': {
        requested: 'continue_current',
        carrierCapability: {
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          deliverySemantics: 'exact_active_turn',
        },
        fallbackAt: 1_000,
        fallbackReason: 'no_active_parent',
      },
    });
  });

  test('admission never binds a stale or foreign-owned parent invocation', () => {
    const authorIntentByCatId = resolveQueueAuthorIntentByCatId({
      targetCats: ['opus', 'codex-sol'],
      requested: 'continue_current',
      threadId: 'thread-1',
      userId: 'user-1',
      invocationTracker: {
        has: (_threadId, catId) => catId === 'opus',
        getUserId: (_threadId, catId) => (catId === 'opus' ? 'other-user' : 'user-1'),
        getExecutionId: (_threadId, catId) => `parent-${catId}`,
      },
      resolveCarrierCapability: () => ({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      }),
      now: 1_000,
    });

    assert.deepEqual(authorIntentByCatId, {
      opus: {
        requested: 'continue_current',
        carrierCapability: {
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          deliverySemantics: 'exact_active_turn',
        },
        fallbackAt: 1_000,
        fallbackReason: 'no_active_parent',
      },
      'codex-sol': {
        requested: 'continue_current',
        carrierCapability: {
          provider: 'openai_codex',
          carrier: 'codex_app_server',
          deliverySemantics: 'exact_active_turn',
        },
        fallbackAt: 1_000,
        fallbackReason: 'no_active_parent',
      },
    });
  });

  test('admission fails closed when the exact provider carrier is unsupported or undeclared', () => {
    const invocationTracker = {
      has: () => true,
      getUserId: () => 'user-1',
      getExecutionId: (_threadId, catId) => `parent-${catId}`,
    };
    const unsupported = resolveQueueAuthorIntentByCatId({
      targetCats: ['opus'],
      requested: 'continue_current',
      threadId: 'thread-1',
      userId: 'user-1',
      invocationTracker,
      resolveCarrierCapability: () => ({
        provider: 'anthropic',
        carrier: 'claude_print_sdk',
        deliverySemantics: 'unsupported',
      }),
      now: 1_000,
    });
    const undeclared = resolveQueueAuthorIntentByCatId({
      targetCats: ['kimi'],
      requested: 'continue_current',
      threadId: 'thread-1',
      userId: 'user-1',
      invocationTracker,
      now: 1_000,
    });

    assert.deepEqual(unsupported.opus, {
      requested: 'continue_current',
      carrierCapability: {
        provider: 'anthropic',
        carrier: 'claude_print_sdk',
        deliverySemantics: 'unsupported',
      },
      fallbackAt: 1_000,
      fallbackReason: 'unsupported_carrier',
    });
    assert.deepEqual(undeclared.kimi, {
      requested: 'continue_current',
      carrierCapability: {
        provider: 'other',
        carrier: 'other',
        deliverySemantics: 'undeclared',
      },
      fallbackAt: 1_000,
      fallbackReason: 'carrier_capability_undeclared',
    });
  });

  test('a legacy composition without a capability resolver becomes explicit undeclared truth', () => {
    assert.deepEqual(resolveFreshnessCarrierCapabilityOrUndeclared({}, 'opus'), {
      provider: 'other',
      carrier: 'other',
      deliverySemantics: 'undeclared',
    });
  });

  test('server admission resolves thread over global while an explicit one-shot wins', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'f264-disposition-admission-'));
    try {
      saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
      assert.equal(resolveMessageDispositionForAdmission({ projectRoot, threadId: 'thread-a' }), 'continue_current');

      saveMessageDispositionPreference(projectRoot, {
        scope: 'thread',
        threadId: 'thread-a',
        disposition: 'next_work',
      });
      assert.equal(resolveMessageDispositionForAdmission({ projectRoot, threadId: 'thread-a' }), 'next_work');
      assert.equal(
        resolveMessageDispositionForAdmission({
          explicit: 'continue_current',
          projectRoot,
          threadId: 'thread-a',
        }),
        'continue_current',
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('terminal parent appends a fallback fact and permanently closes the exposure window', () => {
    const result = queue.enqueue(
      entry({
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: 'parent-a' },
        },
      }),
    );

    const changed = queue.fallbackAuthorIntentsForParentAcrossUsers('thread-1', 'opus', 'parent-a', 2_000);

    assert.deepEqual(changed, [{ entryId: result.entry.id, userId: 'user-1' }]);
    assert.deepEqual(queue.getQueuedBodyMessagesForCat('thread-1', 'user-1', 'opus', 'parent-a'), []);
    assert.deepEqual(queue.getEntrySnapshot('thread-1', 'user-1', result.entry.id).authorIntentByCatId.opus, {
      requested: 'continue_current',
      boundParentInvocationId: 'parent-a',
      fallbackAt: 2_000,
      fallbackReason: 'parent_terminal_before_exposure',
    });
  });

  test('send schema accepts only the two typed dispositions', () => {
    assert.equal(
      sendMessageSchema.safeParse({ content: 'A 补充', messageDisposition: 'continue_current' }).success,
      true,
    );
    assert.equal(sendMessageSchema.safeParse({ content: '问题 B', messageDisposition: 'next_work' }).success, true);
    assert.equal(sendMessageSchema.safeParse({ content: 'no guessing', messageDisposition: 'steer' }).success, false);
  });

  test('multipart parsing preserves the typed disposition instead of dropping author intent', async () => {
    const { parseMultipart } = await import('../dist/routes/parse-multipart.js');
    const request = {
      parts: async function* () {
        yield { type: 'field', fieldname: 'content', value: '带图补充问题 A' };
        yield { type: 'field', fieldname: 'threadId', value: 'thread-1' };
        yield { type: 'field', fieldname: 'messageDisposition', value: 'continue_current' };
      },
    };

    const result = await parseMultipart(request, '/tmp/uploads');

    assert.ok(!('error' in result));
    assert.equal(result.messageDisposition, 'continue_current');
  });
});
