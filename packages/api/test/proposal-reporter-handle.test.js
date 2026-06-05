// @ts-check
/**
 * F128 parallel reporter handle resolution (round-7 → round-9).
 *
 * dispatch's explicit `#ideate` branch wakes multiple cats in parallel.
 * The "## 主 Thread" header injects an explicit "report-back owner" line
 * naming one of the parallel cats as the synthesizer + cross-poster
 * (others are told NOT to cross_post, preventing duplicate reports).
 *
 * Three reviewer rounds beat on the reporter handle resolution:
 *   - 砚砚 round-7 P1: enrich's preferredCats-only mode detection missed
 *     the preferredCats=[] + raw `@cats` path. Added raw `@<token>` regex
 *     fallback.
 *   - chatgpt-codex bot round-8 P2: round-7 regex was ASCII-only — CJK
 *     handles (`@砚砚`) failed. Widened to `[\p{L}\p{N}_-]` + `u` flag.
 *   - chatgpt-codex bot round-9 P2: dotted handles (`@gpt-5.2`) got
 *     truncated to `@gpt-5` (dot not in charclass) — non-handle named
 *     as reporter, cats can't recognise self.
 *
 * Round-9 plan-based fix landed here in dispatch (not enrich): the
 * reporter handle is computed from the router-resolved catId via
 * `primaryMentionHandleForCatId`. This closes the 補锅匠 trap — every
 * future handle shape works because dispatch reads catIds (canonical
 * configured identifiers), not raw token text.
 *
 * Lives separately from proposal-explicit-intent.test.js to honor the
 * AC-X1 ≤350-line file cap and to keep the resolution contract as its
 * own readable unit.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

describe('F128 parallel reporter handle resolution', () => {
  test('preferredCats=[] + raw ASCII `@cats`: reporter resolves to canonical handle of first router-resolved catId', async () => {
    // Originally砚砚 round-7 P1 (raw fallback). Round-9 plan-based:
    // reporter = primaryMentionHandleForCatId(resolved.targetCats[0]).
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
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
            reportingMode: 'final-only',
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

    assert.deepEqual(entries[0].targetCats, ['kimi', 'gemini', 'codex'], 'wake all router-resolved targets');
    assert.equal(entries[0].intent, 'ideate');
    assert.ok(!enqueued.includes('最后一棒猫'), 'parallel mode must NOT inherit serial rule');
    assert.ok(enqueued.includes('report-back owner'), 'must inject parallel reporter');
    const ownerLineMatch = enqueued.match(/report-back owner[^\n]*/);
    assert.ok(
      ownerLineMatch && ownerLineMatch[0].includes('kimi'),
      `reporter must name kimi; got ${ownerLineMatch?.[0]}`,
    );
    assert.ok(!enqueued.includes('## 接力链路'), 'chain protocol suppressed in parallel mode');
  });

  test('preferredCats=[] + raw CJK `@砚砚`: reporter shows canonical primary handle (router-resolved catId), not raw token', async () => {
    // bot round-8 P2 (ASCII-only regex). Round-9 plan-based: reporter
    // is the canonical configured handle of resolved.targetCats[0] —
    // regardless of which alias the user typed in raw.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        // Router resolves Chinese alias `@砚砚` → catId `codex` per cat-template.json.
        return { targetCats: ['codex', 'opus'], intent: { intent: 'ideate' }, hasMentions: true };
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
          body: { initialMessage: '#ideate @砚砚 @宪宪 大家并行想想', preferredCats: [], reportingMode: 'final-only' },
        })
      ).body,
    );

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const entries = invocationQueue.list(body.threadId, 'alice');
    assert.equal(entries.length, 1);
    const enqueued = entries[0].content;

    assert.ok(!enqueued.includes('最后一棒猫'), 'CJK alias path must NOT inherit serial rule');
    assert.ok(enqueued.includes('report-back owner'), 'must inject parallel reporter');
    const ownerLineMatch = enqueued.match(/report-back owner[^\n]*/);
    assert.ok(
      ownerLineMatch && ownerLineMatch[0].includes('codex'),
      `reporter must be canonical handle of resolved.targetCats[0]=codex; got ${ownerLineMatch?.[0]}`,
    );
    assert.ok(!enqueued.includes('## 接力链路'), 'chain protocol suppressed in parallel mode');
  });

  test('preferredCats=[] + raw dotted handle `@gpt-5.2`: reporter preserves full dotted catId (round-9 bot)', async () => {
    // bot round-9 P2 (regex missed `.`). Round-9 plan-based: dispatch
    // reads router-resolved catId `gpt-5.2`, so the dot is naturally
    // preserved — there's no raw regex to misconfigure.
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    const router = {
      async resolveTargetsAndIntent() {
        return { targetCats: ['gpt-5.2', 'gpt-5.4'], intent: { intent: 'ideate' }, hasMentions: true };
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
            initialMessage: '#ideate @gpt-5.2 @gpt-5.4 大家想想 dotted handle',
            preferredCats: [],
            reportingMode: 'final-only',
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

    assert.ok(!enqueued.includes('最后一棒猫'), 'dotted handle path must NOT inherit serial rule');
    assert.ok(enqueued.includes('report-back owner'), 'must inject parallel reporter');
    const ownerLineMatch = enqueued.match(/report-back owner[^\n]*/);
    assert.ok(ownerLineMatch, 'must find owner line');
    assert.ok(
      ownerLineMatch[0].includes('gpt-5.2'),
      `reporter must contain full dotted catId; got ${ownerLineMatch[0]}`,
    );
    assert.ok(
      !/\bgpt-5\b(?!\.)/.test(ownerLineMatch[0]),
      `reporter must NOT contain bare \`gpt-5\` (without dot suffix); got ${ownerLineMatch[0]}`,
    );
  });
});
