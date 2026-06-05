// @ts-check
/**
 * F128 Phase Y — reportingMode dispatch in enrichWithParentThreadHeader.
 *
 * Unit-level coverage of the 4 reporting modes (none / final-only /
 * state-transitions / blocking-ack) and the two orthogonality guards the
 * design discussion locked in (spec docs/features/F128 Phase Y):
 *
 *  - C-Y5: default `none` must NOT tell cats to 回到主 Thread (the old hard-wired
 *    report-back default is exactly what Phase Y removes).
 *  - C-Y6: `#ideate` (wake dimension) is ORTHOGONAL to reportingMode
 *    (report dimension). `#ideate + none` must NOT name a report-back owner.
 *
 * Default (no reportingMode arg) === 'none' (AC-Y6, owner sign-off 2026-06-04).
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
  test('default (no reportingMode) → none/autonomous, no forced report-back (AC-Y6)', () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi');
    assert.ok(out.includes('## 主 Thread'), 'parent-thread header still injected');
    assert.ok(
      out.includes('autonomous') || out.includes('无强制回报'),
      'default none must say autonomous / 无强制回报',
    );
    assert.ok(!out.includes('回到主 Thread'), 'C-Y5: none must NOT tell cats to 回到主 Thread');
    assert.ok(out.includes('cat_cafe_cross_post_message'), 'C-Y2: none still mentions cross-post for critical events');
  });

  test("reportingMode='none' explicit → same as default", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'none');
    assert.ok(out.includes('autonomous') || out.includes('无强制回报'));
    assert.ok(!out.includes('回到主 Thread'), 'C-Y5');
  });

  test("reportingMode='final-only' serial → last cat reports summary once", () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, SOLO, 'hi', null, undefined, 'final-only');
    assert.ok(out.includes('final-only'), 'mode label present');
    assert.ok(out.includes('最后一棒'), 'serial final-only points at last cat');
    assert.ok(out.includes('cat_cafe_cross_post_message'), 'final-only reports via cross_post');
    assert.ok(out.includes('回到主 Thread'), 'serial chain tail returns to main thread when not none');
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

  test('C-Y6: #ideate + none → NO reporter owner injected (orthogonality)', () => {
    const out = enrichWithParentThreadHeader('hi', SRC, TITLE, PAIR, '#ideate go', null, undefined, 'none');
    assert.ok(
      !out.includes('report-back owner') && !out.includes('综合所有并行'),
      'C-Y6: #ideate + none must NOT name a report-back owner',
    );
    assert.ok(out.includes('autonomous') || out.includes('无强制回报'), 'still autonomous');
  });
});
