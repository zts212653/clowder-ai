// @ts-check
/**
 * F128 explicit intent override behaviour (砚砚 PR #809 round-5 — P1 + P2).
 *
 * The cat-driven @-chain is the DEFAULT for F128 approve dispatch — wake
 * `preferredCats[0]`, let cats hand off via line-start @-mentions in their
 * own replies. But explicit user intent tags (`#ideate` / `#execute`) in
 * the raw initialMessage are escape hatches and must override:
 *
 *   - `#ideate` + multi preferredCats → wake all in parallel AND suppress
 *     the serial chain protocol in the enriched header (otherwise the
 *     runtime wakes parallel while the message tells cats to behave
 *     serially — direct contradiction).
 *
 *   - `#execute` + preferredCats=[] + multi router-resolved targets →
 *     preserve all targets as serial multi-cat execution (silently
 *     collapsing to the first resolved target would discard explicit
 *     user intent).
 *
 * Lives separately from proposal-chain-protocol.test.js (which owns the
 * default chain protocol injection contract) to honor the AC-X1 ≤350-line
 * file cap and to keep "mode-aware dispatch" as its own readable unit.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 explicit intent override (round-5)', () => {
  test('explicit `#ideate` + multiple preferredCats: suppress chain protocol (parallel cats must NOT be told to hand off serially)', async () => {
    // 砚砚 PR #809 round-5 P1: enrichWithParentThreadHeader used to inject
    // the serial chain protocol whenever preferredCats was non-empty. But
    // dispatch's explicit-`#ideate` branch wakes ALL preferredCats in
    // parallel — so every woken cat would receive a message saying "Server
    // only woke me as the first cat, I should hand off serially with
    // line-start @-mention". The runtime wakes parallel; the message tells
    // them to behave serially. Direct contradiction → unnecessary handoffs
    // + duplicate report-back. Fix: detect explicit `#ideate` from raw
    // initialMessage in enrich, omit chain protocol in parallel mode.
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
            preferredCats: ['kimi', 'gemini', 'codex'],
          },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);
    const enqueued = entries[0].content;

    // Runtime behaviour: dispatch wakes ALL preferredCats in parallel.
    assert.deepEqual(
      entries[0].targetCats,
      ['kimi', 'gemini', 'codex'],
      'explicit #ideate must wake all preferredCats in parallel',
    );
    assert.equal(entries[0].intent, 'ideate', 'intent must be ideate (parallel)');

    // Message contract: cats receive the main thread header but NOT the
    // serial chain protocol section (woken in parallel, not as a chain).
    assert.ok(enqueued.includes('## 主 Thread'), 'main thread header still present (skill Step 5c report-back)');
    assert.ok(!enqueued.includes('## 接力链路'), 'serial chain protocol section MUST be suppressed for parallel mode');
    assert.ok(!enqueued.includes('Server 只 wake 了'), 'must NOT tell parallel cats that only the first cat was woken');
    assert.ok(
      !enqueued.includes('行首独立一行'),
      'must NOT instruct parallel cats to hand off with line-start @-mention',
    );

    // 砚砚 round-6 P1: parallel mode must NOT inherit the default "最后一棒猫
    // reports back" rule, because there IS no "last cat" — all cats reply
    // simultaneously and the report-back owner becomes undefined. Either no
    // one cross-posts (lost report) or everyone does (duplicate reports).
    // Fix: parallel mode pins preferredCats[0] (card order ground truth) as
    // the explicit synthesizer + reporter; other parallel cats reply but
    // must NOT cross_post to avoid duplicate reports.
    assert.ok(
      !enqueued.includes('最后一棒猫'),
      'parallel mode must NOT inherit the "last cat reports back" rule — there is no last cat',
    );
    assert.ok(
      enqueued.includes('并行模式 report-back owner'),
      'parallel mode must inject an explicit report-back owner line',
    );
    // Find the report-back owner line and assert it names preferredCats[0]=kimi.
    const ownerLineMatch = enqueued.match(/并行模式 report-back owner[^\n]*/);
    assert.ok(ownerLineMatch, 'must find the report-back owner line');
    assert.ok(
      ownerLineMatch[0].includes('kimi'),
      `report-back owner must be preferredCats[0]=kimi; got line: ${ownerLineMatch[0]}`,
    );
    // The other parallel cats must be told NOT to cross_post themselves
    // (otherwise we get duplicate cross-posts — the original "没人回报主
    // thread" symptom, just flipped to "everyone reports").
    assert.ok(
      enqueued.includes('不要') && enqueued.includes('cat_cafe_cross_post_message'),
      'must explicitly tell non-reporter parallel cats NOT to cross_post (prevents duplicate reports)',
    );
  });

  test('explicit `#ideate` + preferredCats=[] + raw `@-mentions`: parallel report-back owner falls back to raw first @-token', async () => {
    // 砚砚 PR #809 round-7 P1: round-6 fix only covered preferredCats non-empty.
    // dispatch's other parallel path — explicit `#ideate` + preferredCats=[]
    // + raw `@A @B @C` — wakes resolved.targetCats parallel via the
    // `targetCats = preferredCats.length > 0 ? preferredCats : resolved.targetCats`
    // branch, but enrich previously required preferredCats.length > 0 for
    // mode detection. Result: parallel cats woken, but message still says
    // "最后一棒猫 reports back" — fork-and-return owner undefined again,
    // same failure shape as round-6 just through a different code path.
    //
    // Fix: enrich detects parallel mode from raw alone (no preferredCats
    // precondition) and falls back to raw first @-token as reporter handle.
    // This matches what router resolves first AND what dispatch wakes first
    // (in raw-mention order) — a faithful approximation without requiring
    // enrich to peek the router.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        // Simulate router: raw `#ideate @kimi @gemini @codex` resolves all 3.
        return { targetCats: ['kimi', 'gemini', 'codex'], intent: { intent: 'ideate' }, hasMentions: true };
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
            initialMessage: '#ideate @kimi @gemini @codex 大家并行想',
            preferredCats: [],
          },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);
    const enqueued = entries[0].content;

    // Runtime: dispatch wakes all 3 router-resolved targets in parallel.
    assert.deepEqual(
      entries[0].targetCats,
      ['kimi', 'gemini', 'codex'],
      'preferredCats=[] + explicit #ideate must wake all router-resolved targets parallel',
    );
    assert.equal(entries[0].intent, 'ideate', 'intent must be ideate (parallel)');

    // The round-7 contract: header must NOT inherit serial "最后一棒猫" rule
    // and MUST declare an explicit parallel reporter owner.
    assert.ok(
      !enqueued.includes('最后一棒猫'),
      'parallel mode (preferredCats=[] path) must NOT inherit "last cat reports back"',
    );
    assert.ok(
      enqueued.includes('并行模式 report-back owner'),
      'parallel mode must inject explicit report-back owner line even when preferredCats=[]',
    );
    const ownerLineMatch = enqueued.match(/并行模式 report-back owner[^\n]*/);
    assert.ok(ownerLineMatch, 'must find the report-back owner line');
    assert.ok(
      ownerLineMatch[0].includes('@kimi'),
      `reporter must fall back to raw first @-token (@kimi); got line: ${ownerLineMatch[0]}`,
    );
    assert.ok(
      !enqueued.includes('## 接力链路'),
      'chain protocol section still suppressed in parallel mode (round-5 contract)',
    );
  });

  test('explicit `#execute` + preferredCats=[] + multi-target raw: preserve all targets (do not silently collapse to first)', async () => {
    // 砚砚 PR #809 round-5 P2: previously dispatch fell through to
    // `firstCandidate = preferredCats?.[0] ?? resolved.targetCats[0]` for
    // anything that wasn't explicit `#ideate`. So a raw initialMessage like
    // `#execute @kimi @gemini @codex` with no preferredCats override would
    // silently wake only the first router-resolved target — discarding the
    // user's explicit multi-target intent. Fix: explicit `#execute` with
    // empty preferredCats and multiple resolved targets preserves all of
    // them as serial multi-cat execution (the F088 router contract for
    // `#execute` outside F128-specific override).
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        // Simulate real router: raw `#execute @kimi @gemini @codex` →
        // resolved.targetCats = [kimi, gemini, codex].
        return { targetCats: ['kimi', 'gemini', 'codex'], intent: { intent: 'execute' }, hasMentions: true };
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
            initialMessage: '#execute @kimi @gemini @codex 一起办这个事',
            preferredCats: [],
          },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);

    assert.deepEqual(
      entries[0].targetCats,
      ['kimi', 'gemini', 'codex'],
      'explicit #execute + preferredCats=[] + multi-target raw must preserve all router-resolved targets',
    );
    assert.equal(entries[0].intent, 'execute', 'intent stays execute (serial multi-cat, not parallel ideation)');
  });
});
