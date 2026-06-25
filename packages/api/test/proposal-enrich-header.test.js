// @ts-check
/**
 * F128 Phase Y — reportingMode dispatch in enrichWithParentThreadHeader.
 *
 * Unit-level coverage of the 4 reporting modes (none / final-only /
 * state-transitions / blocking-ack) and the two orthogonality guards the
 * design discussion locked in (spec docs/features/F128 Phase Y):
 *
 *  - C-Y5: explicit `none` must NOT tell cats to 回到主 Thread (the old hard-wired
 *    report-back text is exactly what Phase Y split by mode).
 *  - C-Y6: `#ideate` (wake dimension) is ORTHOGONAL to reportingMode
 *    (report dimension). `#ideate + none` must NOT name a report-back owner.
 *
 * Phase AA superseded the default: no reportingMode arg now means final-only.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { enrichWithParentThreadHeader } from '../dist/routes/proposal-enrich-header.js';

const SRC = 'thread_src1';
const TITLE = 'Parent Topic';
// CatId is a branded type; pass plain string ids through an `any` cast.
const SOLO = /** @type {any} */ (['opus']);
const PAIR = /** @type {any} */ (['opus', 'codex']);

describe('F128 Phase Y — enrichWithParentThreadHeader reportingMode', () => {
  // AC-AA1: Phase AA supersedes Phase Y default. Default is now 'final-only'.
  test('default (no reportingMode) → final-only report-back (AC-AA1, supersedes AC-Y6)', () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi');
    assert.ok(out.includes('## 主 Thread'), 'parent-thread header still injected');
    assert.ok(out.includes('final-only'), 'AC-AA1: default must be final-only, not none/autonomous');
    assert.ok(out.includes('cat_cafe_cross_post_message'), 'final-only reports via cross_post');
    // final-only chain order line should NOT include "→ 回到主 Thread" as a chain step —
    // it misleads intermediate cats into thinking reporting back is their job.
    // The final report instruction lives in the chain steps, not the order line.
    const orderMatch = out.match(/顺序:\s*([^\n]+)/);
    if (orderMatch) {
      assert.ok(
        !orderMatch[1].includes('回到主 Thread'),
        'final-only chain order line must NOT include "→ 回到主 Thread" (misleads intermediate cats)',
      );
    }
  });

  test("reportingMode='none' explicit → autonomous, no forced return", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'none');
    assert.ok(out.includes('autonomous') || out.includes('无强制回报'));
    assert.ok(!out.includes('回到主 Thread'), 'C-Y5');
  });

  test("reportingMode='final-only' serial → self-governing thread, report once after task closure", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'final-only');
    assert.ok(out.includes('final-only'), 'mode label present');
    assert.ok(out.includes('cat_cafe_cross_post_message'), 'final-only reports via cross_post');
    // New: final-only must explicitly PROHIBIT mid-process cross_post
    assert.ok(out.includes('禁止'), 'final-only must use 禁止 (prohibit), not 不必 (not necessary)');
    assert.ok(
      !out.includes('中途不必'),
      'old weak "中途不必逐步回报" language must be removed — too easily overridden by L0 rules',
    );
    // New: final-only must frame the thread as self-governing
    assert.ok(
      out.includes('本 Thread 自治') || out.includes('自治推进'),
      'final-only must frame the sub-thread as self-governing (本 Thread 自治)',
    );
    // New: "final" means task closure (PR merged / task closed), not "last cat finished their step"
    assert.ok(
      out.includes('PR 合入') || out.includes('任务关闭') || out.includes('任务完成'),
      'final-only must define completion as task closure (PR merged / task closed), not "last step done"',
    );
  });

  test("reportingMode='final-only' parallel (#ideate) → reporter owner = first cat", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, PAIR, '#ideate go', null, undefined, 'final-only');
    assert.ok(out.includes('final-only'));
    assert.ok(
      out.includes('report-back owner') || out.includes('综合所有并行'),
      'parallel final-only names a reporter owner',
    );
    assert.ok(!out.includes('接力链路'), 'parallel mode does NOT inject the serial chain section');
  });

  test("reportingMode='state-transitions' → phase boundary reporting", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'state-transitions');
    assert.ok(out.includes('state-transitions'));
    assert.ok(out.includes('phase boundary') || out.includes('阶段'), 'mentions phase boundary');
  });

  test("reportingMode='blocking-ack' → BLOCKING + hold_ball, downstream holds", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'blocking-ack');
    assert.ok(out.includes('blocking-ack'));
    assert.ok(out.includes('[BLOCKING]'), 'blocking-ack tells downstream to send [BLOCKING] request');
    assert.ok(out.includes('cat_cafe_hold_ball'), 'C-Y3: downstream holds via hold_ball');
  });

  test('state-transitions and blocking-ack chain order STILL includes "→ 回到主 Thread"', () => {
    for (const mode of /** @type {const} */ (['state-transitions', 'blocking-ack'])) {
      const out = enrichWithParentThreadHeader('hi', SRC, TITLE, PAIR, 'hi', null, undefined, mode);
      const orderMatch = out.match(/顺序:\s*([^\n]+)/);
      assert.ok(orderMatch, `${mode}: chain order line must exist`);
      assert.ok(
        orderMatch[1].includes('回到主 Thread'),
        `${mode}: chain order line SHOULD include "→ 回到主 Thread" (process reporting modes)`,
      );
    }
  });

  test('final-only serial chain includes explicit mid-process prohibition for intermediate cats', () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, PAIR, 'hi', null, undefined, 'final-only');
    assert.ok(out.includes('接力链路'), 'chain protocol injected');
    // Chain protocol must include an explicit prohibition for intermediate cats
    assert.ok(
      out.includes('禁止') && (out.includes('cross_post') || out.includes('cross-post')),
      'chain protocol must explicitly prohibit mid-process cross_post to main thread',
    );
  });

  test('C-Y6: #ideate + none → NO reporter owner injected (orthogonality)', () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, PAIR, '#ideate go', null, undefined, 'none');
    assert.ok(
      !out.includes('report-back owner') && !out.includes('综合所有并行'),
      'C-Y6: #ideate + none must NOT name a report-back owner',
    );
    assert.ok(out.includes('autonomous') || out.includes('无强制回报'), 'still autonomous');
  });
});

describe('F128 Phase AA — routing credentials in report-back headers', () => {
  test('AC-AA6: final-only serial header includes sourceThreadId + source handle routing (AC-AA6)', () => {
    const out = enrichWithParentThreadHeader(
      'hi',
      SRC,
      TITLE,
      SOLO,
      'hi',
      null,
      undefined,
      'final-only',
      // Phase AA: sourceCatHandle for routing credentials
      '@proposer-cat',
    );
    assert.ok(
      out.includes('targetCats') || out.includes('@proposer-cat'),
      'AC-AA6: final-only report-back must include routing credentials (targetCats or @handle)',
    );
    assert.ok(
      out.includes(SRC),
      'AC-AA6: report-back header must reference sourceThreadId so cats know where to cross-post',
    );
    // P1-3: routing must be copyable — actual catId, not placeholder
    assert.ok(
      out.includes('targetCats: ["proposer-cat"]'),
      'P1-3: targetCats must contain actual catId (proposer-cat), not a placeholder',
    );
    assert.ok(!out.includes('["..."]'), 'P1-3: output must not contain non-copyable ["..."] placeholder');
  });

  test('AC-AA6: state-transitions header includes routing credentials', () => {
    const out = enrichWithParentThreadHeader(
      'hi',
      SRC,
      TITLE,
      SOLO,
      'hi',
      null,
      undefined,
      'state-transitions',
      '@proposer-cat',
    );
    assert.ok(
      out.includes('targetCats') || out.includes('@proposer-cat'),
      'AC-AA6: state-transitions report-back must include routing credentials',
    );
  });

  test('AC-AA6: blocking-ack header includes routing credentials', () => {
    const out = enrichWithParentThreadHeader(
      'hi',
      SRC,
      TITLE,
      SOLO,
      'hi',
      null,
      undefined,
      'blocking-ack',
      '@proposer-cat',
    );
    assert.ok(
      out.includes('targetCats') || out.includes('@proposer-cat'),
      'AC-AA6: blocking-ack report-back must include routing credentials',
    );
  });

  test('AC-AA7: none/autonomous header reminds about targetCats for voluntary cross-posts', () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'none', '@proposer-cat');
    assert.ok(
      out.includes('targetCats') || out.includes('@proposer-cat'),
      'AC-AA7: even none mode must remind cats to use targetCats or @handle when cross-posting',
    );
  });

  test('AC-AA6: serial chain final step includes routing credentials', () => {
    const out = enrichWithParentThreadHeader(
      'hi',
      SRC,
      TITLE,
      PAIR,
      'hi',
      null,
      undefined,
      'final-only',
      '@proposer-cat',
    );
    // The chain final step should tell the last cat to target the source cat
    assert.ok(
      out.includes('targetCats') || out.includes('@proposer-cat'),
      'AC-AA6: serial chain final step must have routing credentials for cross-post',
    );
    // P1-3: chain routing hint must also be copyable
    assert.ok(
      out.includes('"proposer-cat"'),
      'P1-3: chain final step routing hint must contain actual catId, not placeholder',
    );
  });

  test('P1-3: no ["..."] placeholder anywhere in output when sourceCatHandle is provided', () => {
    // Pin the contract: every reporting mode + chain must emit copyable routing.
    for (const mode of /** @type {const} */ (['none', 'final-only', 'state-transitions', 'blocking-ack'])) {
      const out = enrichWithParentThreadHeader('hi', SRC, TITLE, PAIR, 'hi', null, undefined, mode, '@source-cat');
      assert.ok(
        !out.includes('["..."]'),
        `P1-3: ${mode} output must not contain non-copyable ["..."] placeholder; got:\n${out}`,
      );
      // When sourceCatHandle is provided, the actual catId must appear
      assert.ok(out.includes('source-cat'), `P1-3: ${mode} output must reference actual source catId "source-cat"`);
    }
  });
});
