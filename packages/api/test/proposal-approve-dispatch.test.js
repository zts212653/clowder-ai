// @ts-check
/**
 * F128 approve dispatch — initialMessage routing through the queue processor.
 *
 * Core lifecycle (propose / approve / reject mechanics) stays in
 * `proposal-flow.test.js`. This file holds the higher-level "what happens to
 * the initial message when the user approves a proposal" behaviours:
 *
 *  - approve dispatches initialMessage via router + InvocationQueue + processNext
 *  - preferredCats fallback when router resolves 0 targets from message text
 *  - explicit #ideate / #execute tags vs default serial intent
 *  - server-injected "## 主 Thread" header (fork-and-return / skill Step 5c)
 *  - explicit @-mention in content beats preferredCats fallback
 *
 * Split out from proposal-flow.test.js to honor AC-X1 ≤350-line file cap
 * (砚砚 re-review on fd8f07ae..76e8d164 flagged the regression).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 approve dispatch — initialMessage routing', () => {
  test('approve dispatches initialMessage through the queue processor', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const resolveCalls = [];
    const processCalls = [];
    const router = {
      async resolveTargetsAndIntent(content, threadId, options) {
        resolveCalls.push({ content, threadId, options });
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.warnings, undefined);
    assert.equal(resolveCalls.length, 1);
    // Server now injects "## 主 Thread" header (skill Step 5c fork-and-return),
    // so router sees enriched content. The header is additive — user-typed
    // content still appears at the start.
    assert.ok(
      resolveCalls[0].content.startsWith('Kick this off'),
      'router input should start with user-typed initialMessage',
    );
    assert.equal(resolveCalls[0].threadId, body.threadId);
    assert.equal(resolveCalls[0].options.persist, true);
    assert.deepEqual(processCalls, [{ threadId: body.threadId, userId: 'alice' }]);

    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);
    assert.ok(entries[0].content.startsWith('Kick this off'), 'enqueued content should start with user-typed content');
    assert.deepEqual(entries[0].targetCats, ['opus']);
    assert.equal(entries[0].intent, 'execute');
    assert.ok(entries[0].messageId);
    const stored = await ctx.messageStore.getById(entries[0].messageId);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.mentions, ['opus']);
  });

  test('approve falls back to preferredCats when initialMessage has no @-mention', async () => {
    // The product bug this pins: cat proposes a thread with preferredCats=[kimi,gemini25,codex]
    // and an initialMessage like "开玩！" (no @-mention). Without fallback, the router resolves
    // 0 targets, dispatch silently skips, and only the thread owner ever gets woken up via the
    // user's next manual message. With fallback, the proposal's chosen members get woken up
    // immediately as the user intended when picking them on the card.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        // Simulate the real router behaviour for a no-@-mention message: 0 targets.
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          body: { initialMessage: '开玩！', preferredCats: ['kimi', 'gemini', 'codex'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.warnings, undefined, 'fallback should succeed without warnings');
    assert.deepEqual(processCalls, [{ threadId: body.threadId, userId: 'alice' }]);

    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);
    assert.deepEqual(
      entries[0].targetCats,
      ['kimi', 'gemini', 'codex'],
      'targetCats must come from preferredCats when content has no @-mention',
    );
    assert.equal(
      entries[0].intent,
      'execute',
      'fallback intent must default to serial (execute) so preferredCats order is honored as a chain — picking members on the card implies an ordered walk, not parallel ideate',
    );
    const stored = await ctx.messageStore.getById(entries[0].messageId);
    assert.deepEqual(
      stored.mentions,
      ['kimi', 'gemini', 'codex'],
      'message mentions must reflect the fallback targets so cats see why they were woken',
    );
  });

  test('approve fallback honors explicit #ideate tag (parallel still opt-in)', async () => {
    // Defensive: if the user genuinely wants parallel ideation, they tag #ideate
    // explicitly in initialMessage. Fallback must NOT clobber that intent down
    // to execute — explicit user tags always win.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'ideate' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext() {
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          body: {
            initialMessage: '#ideate 大家分别说说自己的看法',
            preferredCats: ['kimi', 'gemini'],
          },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries[0].intent, 'ideate', 'explicit #ideate must override the proposal-card serial default');
  });

  test('approve injects "## 主 Thread" header into sub-thread first message (fork-and-return loop)', async () => {
    // thread-orchestration skill Step 5c: cats in the sub-thread must be able
    // to find the parent thread so they can report back when work is done.
    // Server defensively injects the header so cats who forget to write it in
    // initialMessage still preserve the fork-and-return loop.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
      },
    };
    const queueProcessor = {
      async processNext() {
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Strategy Discussion');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          body: { initialMessage: '开玩！我先起头：一帆风顺', preferredCats: ['opus'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);
    const enqueued = entries[0].content;
    assert.ok(
      enqueued.includes('## 主 Thread'),
      `enqueued content must include "## 主 Thread" header; got:\n${enqueued}`,
    );
    assert.ok(enqueued.includes(source.id), 'header must contain sourceThreadId so cats can locate parent');
    assert.ok(enqueued.includes('Strategy Discussion'), 'header must contain sourceThread title when available');
    assert.ok(
      enqueued.includes('cat_cafe_cross_post_message'),
      'header must remind cats to cross_post the report back via cat_cafe_cross_post_message',
    );
    // Original user content must still be present — header is additive, not destructive.
    assert.ok(enqueued.includes('开玩！我先起头：一帆风顺'), 'original user-typed content must be preserved verbatim');

    // The proposal store must keep the user-typed content RAW (no header) — the
    // header is a thread-message artifact, not part of the proposal record.
    const stored = await ctx.proposalStore.get(proposalId);
    assert.equal(
      stored.initialMessage,
      '开玩！我先起头：一帆风顺',
      'proposal record stores user-typed initialMessage verbatim; header lives only in the thread message',
    );
  });

  test('approve preserves router-resolved targets when initialMessage has @-mention (no fallback)', async () => {
    // Defensive: if the user explicitly @-mentions someone in initialMessage, the router's
    // resolution wins — preferredCats does NOT override the explicit user intent.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: ['codex'], intent: { intent: 'execute' }, hasMentions: true };
      },
    };
    const queueProcessor = {
      async processNext() {
        return { started: true };
      },
    };
    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          body: {
            initialMessage: '@codex 帮我看一下',
            preferredCats: ['kimi', 'gemini'],
          },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.deepEqual(
      entries[0].targetCats,
      ['codex'],
      'explicit @-mention in content must beat the preferredCats fallback',
    );
  });
});
