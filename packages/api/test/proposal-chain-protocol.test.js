// @ts-check
/**
 * F128 chain protocol injection (砚砚 PR #809 review P1 — blocking).
 *
 * Server tells the woken cat explicitly that this is a cat-driven @-chain:
 * order, handoff rule, who reports back. Without this, the workflow stalls
 * after one cat (server knows it's cat-driven, but the cat doesn't).
 *
 * These tests live separately from proposal-approve-dispatch.test.js to honor
 * the AC-X1 ≤350-line file cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 chain protocol injection', () => {
  test('approve injects chain protocol with order + handoff instructions when preferredCats has multiple cats', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
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
          body: { initialMessage: '开玩!', preferredCats: ['kimi', 'gemini', 'codex'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    const enqueued = entries[0].content;

    assert.ok(enqueued.includes('## 接力链路'), 'must include chain protocol section');

    const orderLineMatch = enqueued.match(/顺序:\s*([^\n]+)/);
    assert.ok(orderLineMatch, 'must have order line');
    const orderLine = orderLineMatch[1];
    const kimiIdx = orderLine.indexOf('kimi');
    const geminiIdx = orderLine.indexOf('gemini');
    const codexIdx = orderLine.indexOf('codex');
    assert.ok(kimiIdx >= 0 && geminiIdx > kimiIdx && codexIdx > geminiIdx, 'order must follow preferredCats');
    assert.ok(orderLine.includes('回到主 Thread'), 'order must end at 主 Thread');

    assert.ok(enqueued.includes('行首独立一行'), 'must instruct cats to use line-start @-mention for handoff');
    assert.ok(
      enqueued.includes('cat_cafe_cross_post_message'),
      'must mention cross_post_message for final report-back',
    );
    assert.ok(
      enqueued.includes('ideate'),
      'must reference the ideate escape hatch for parallel mode (no literal `#ideate` — would mis-trigger parseIntent)',
    );
    // Defensive: server-injected text must NOT contain literal "#ideate" or
    // parseIntent would read it as an explicit user tag and force parallel.
    assert.ok(!enqueued.includes('#ideate'), 'header must not write literal `#ideate` (parseIntent footgun)');
  });

  test('approve does NOT flip to parallel when parent thread title contains `#ideate` (parseIntent reads raw initialMessage, not enriched content)', async () => {
    // 砚砚 PR #809 review P2: server enriches the first sub-thread message
    // with parent thread title + chain protocol section. Before this fix
    // dispatch called parseIntent(enrichedContent, ...), so a parent thread
    // whose title happened to contain `#ideate` (e.g. an existing "Demo
    // #ideate thread") would force every spawned proposal into parallel mode
    // regardless of what the user typed in initialMessage. Pin the contract:
    // user intent comes from the raw user-typed initialMessage only.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: [], intent: { intent: 'execute' }, hasMentions: false };
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
    // Parent thread title intentionally contains the literal `#ideate` tag.
    const source = await ctx.threadStore.create('alice', 'Parent #ideate title');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          threadId: source.id,
          // Raw user intent: serial chain, no #ideate tag.
          body: { initialMessage: '开玩!', preferredCats: ['kimi', 'gemini', 'codex'] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');

    // The enriched content WILL still contain `#ideate` (verbatim from
    // parent title in the "## 主 Thread" header) — that is expected; the
    // user explicitly named their parent thread that way and the message
    // must stay faithful. The fix is that dispatch parseIntent ignores
    // this header text entirely.
    assert.ok(
      entries[0].content.includes('#ideate'),
      'enriched content faithfully echoes parent title (contains `#ideate`)',
    );

    assert.deepEqual(
      entries[0].targetCats,
      ['kimi'],
      'serial proposal stays serial — only preferredCats[0] is woken, parent-title `#ideate` does NOT leak into parseIntent',
    );
    assert.equal(
      entries[0].intent,
      'execute',
      'intent stays execute (chain starter) — explicit-tag path requires user-typed `#ideate` in raw initialMessage',
    );
  });

  test('approve omits chain protocol when preferredCats is empty (no chain to orchestrate)', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: true };
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
          body: { initialMessage: '@opus help', preferredCats: [] },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    const enqueued = entries[0].content;

    assert.ok(enqueued.includes('## 主 Thread'), 'main thread header still injected even without preferredCats');
    assert.ok(!enqueued.includes('接力链路'), 'chain protocol section must be omitted when preferredCats is empty');
  });
});
