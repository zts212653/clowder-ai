// @ts-check
/**
 * F128 approve dispatch — initialMessage routing through the queue processor.
 *
 * Core lifecycle (propose / approve / reject mechanics) stays in
 * `proposal-flow.test.js`. This file holds the higher-level "what happens to
 * the initial message when the user approves a proposal" behaviours:
 *
 *  - approve dispatches initialMessage via router + InvocationQueue + processNext
 *  - dispatch wakes ONLY preferredCats[0] (chain starter); rest is cat-driven
 *  - explicit #ideate tag opts into "wake all preferredCats" parallel mode
 *  - server-injected "## 主 Thread" header (fork-and-return / skill Step 5c)
 *  - preferredCats[0] is ground truth; message-body @-mentions are narrative
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
    const source = await ctx.threadStore.create('alice', 'Source', '/projects/source-repo');
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
    // 砚砚 PR #809 round-3 P2: router receives the RAW user-typed
    // initialMessage, NOT the enriched "## 主 Thread" header content. The
    // header is injected only into what gets enqueued + stored (so cats see
    // parent-thread pointer + chain protocol), but server-injected text must
    // never leak into router's @mention parser / persist boundary (that
    // would let parent thread title `@cat` mentions silently wake / persist).
    // P3 round-5: pin this contract with equality, not startsWith, so a
    // future regression can't accidentally re-enrich router's input without
    // tripping the test.
    assert.equal(
      resolveCalls[0].content,
      'Kick this off',
      'router input must equal raw initialMessage exactly — no server-injected header',
    );
    assert.ok(
      !resolveCalls[0].content.includes('## 主 Thread'),
      'router input must NOT contain server-injected "## 主 Thread" header',
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
    const source = await ctx.threadStore.create('alice', 'Source', '/projects/source-repo');
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
      ['kimi'],
      'dispatch wakes ONLY preferredCats[0] (first cat); subsequent cats are driven by cat-side @-mentions ("他们自己决定下一个要把谁叫出来" — owner spec 2026-05-27)',
    );
    assert.equal(entries[0].intent, 'execute', 'first-cat dispatch is always serial (intent execute)');
    const stored = await ctx.messageStore.getById(entries[0].messageId);
    assert.deepEqual(
      stored.mentions,
      ['kimi'],
      'message mentions reflect the single woken cat — the chain extends via cat @-mentions in their replies',
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
      'default final-only mentions cross_post for report-back',
    );
    // F128 Phase AA (AC-AA1): default reportingMode is now `final-only`
    // (supersedes Phase Y AC-Y6 default `none`). Cats are told to report back.
    assert.ok(enqueued.includes('final-only'), 'AC-AA1: default must be final-only (supersedes Phase Y none)');
    // F128 final-only hardening: chain order no longer includes "→ 回到主 Thread" for
    // final-only mode (it misleads intermediate cats). The final report instruction lives
    // in the chain steps section, not the order overview line.
    assert.ok(
      enqueued.includes('任务完成') || enqueued.includes('PR 合入') || enqueued.includes('任务关闭'),
      'final-only must define completion as task closure, not last-step-done',
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

    // F128 chain protocol injection (砚砚 PR #809 review P1):
    // single-cat preferredCats still gets the chain section so the cat knows
    // "you are the only invited member; report back when done".
    assert.ok(enqueued.includes('接力链路'), 'chain protocol section must be injected when preferredCats provided');
    assert.ok(enqueued.includes('Server 只 wake 了'), 'chain protocol must explain that only the first cat was woken');
  });

  test('approve always picks preferredCats[0] as first cat (card order is ground truth, message @s are narrative)', async () => {
    // F128 design (owner spec 2026-05-27): the proposal card's preferredCats
    // ORDER is the ground truth for who starts the chain. @-mentions in the
    // initialMessage body are narrative / rule-stating prose (e.g.
    // "@opus46 把球传过去" inside instructions). They must NOT override the
    // card's first-picked member.
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
      ['kimi'],
      'preferredCats[0]=kimi wakes first, even though message body @s @codex — message @s are prompt-level narrative, dispatch follows card order',
    );
    assert.equal(entries[0].intent, 'execute', 'first-cat dispatch is always serial');
  });
});
