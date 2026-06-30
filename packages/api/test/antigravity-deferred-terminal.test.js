import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deferralNearMissSignal,
  isDeferredProgressOnlyTerminal,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-event-transformer.js';

// F211 REG-followup: Antigravity progress-only planner text (e.g. "让我整理分析。")
// was classified as terminal_output → hasText=true → turn silently "completed"
// while the human saw a half-thought. This predicate detects that deferred shape
// so the service can auto-nudge instead of silently finishing.
// Spec converged with codex (砚砚): high-precision TAIL predicate, NOT a broad keyword net.

describe('isDeferredProgressOnlyTerminal — deferred/progress-only terminal text', () => {
  // ── TRIGGER: announces the deliverable (analysis/write-up) but doesn't deliver ──
  test('the real failure original: 让我整理分析 tail → deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal('好了，证据链够了。让我整理分析。'), true);
  });

  test('REG15-adjacent: 让我直接写文件试试 → deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal('让我直接写文件试试。'), true);
  });

  test('multi-sentence progress ending in a deliverable deferral → deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal('我先搜了相关文档，找到了关键线索。接下来我来梳理总结。'), true);
  });

  test('longer deferral sentence still detected (not gated by turn-level length)', () => {
    assert.equal(isDeferredProgressOnlyTerminal('现在让我系统性地整理一下完整的分析'), true);
  });

  // ── DON'T TRIGGER: real answers, post-answer suggestions, legit short replies ──
  test('legit short answer (no deferral verb) → not deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal('是的，可以。'), false);
  });

  test('real answer + trailing next-step SUGGESTION (接下来可以…) → not deferred', () => {
    assert.equal(
      isDeferredProgressOnlyTerminal('结论：全量同步有结构性缺陷，建议改增量。接下来可以优化拆分脚本。'),
      false,
    );
  });

  test('deliverable verb followed by inline colon-delivered content → not deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal('我来总结：方案 A 最优，因为它平衡了成本与质量。'), false);
  });

  test('colon-delivered answer whose body ALSO contains a deliverable verb → not deferred (cloud #2558 P2)', () => {
    // The delivered body "重点是需求分析" contains the verb 分析; the predicate must not
    // anchor on a verb inside delivered content and ignore the leading colon boundary.
    assert.equal(isDeferredProgressOnlyTerminal('我来总结：重点是需求分析。'), false);
    assert.equal(isDeferredProgressOnlyTerminal('让我梳理：先做需求分析，再做架构设计。'), false);
  });

  test('past-tense delivered analysis (我分析了…) → not deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal('我分析了三个方案，最优是 A。'), false);
  });

  test('empty / whitespace / nullish → not deferred', () => {
    assert.equal(isDeferredProgressOnlyTerminal(''), false);
    assert.equal(isDeferredProgressOnlyTerminal('   '), false);
    assert.equal(isDeferredProgressOnlyTerminal(undefined), false);
    assert.equal(isDeferredProgressOnlyTerminal(null), false);
  });
});

// Observability (spec item ③): a terminal tail that LOOKS like a future-action
// deferral (short + first-person intent marker) but the high-precision predicate
// did NOT fire is a NEAR-MISS — log its STRUCTURAL shape (NO raw content) so the
// marker/verb sets can be iterated for English / new phrasings without leaking
// user content. Confirmed deferrals and non-action text return null (nothing to log).
describe('deferralNearMissSignal — observability for predicate iteration', () => {
  test('English intent marker, deliverable verb NOT in set → near-miss (no_deliverable_verb)', () => {
    const signal = deferralNearMissSignal('Let me wrap this up.');
    assert.ok(signal, 'short English future-action tail with no matched verb is a near-miss');
    assert.equal(signal.reason, 'no_deliverable_verb');
    assert.equal(signal.hasIntentMarker, true);
    assert.equal(signal.hasDeliverableVerb, false);
    assert.equal(typeof signal.tailLen, 'number');
  });

  test('Chinese intent marker, verb not in set → near-miss (no_deliverable_verb)', () => {
    const signal = deferralNearMissSignal('让我处理一下。');
    assert.ok(signal);
    assert.equal(signal.reason, 'no_deliverable_verb');
    assert.equal(signal.hasIntentMarker, true);
  });

  test('marker + verb but long object after verb → near-miss (content_after_verb)', () => {
    // "let me organize all the key points discussed today" — a genuine deferral
    // the predicate MISSES because the post-verb object exceeds the tail cap.
    const signal = deferralNearMissSignal('我来整理今天讨论的所有要点');
    assert.ok(signal);
    assert.equal(signal.reason, 'content_after_verb');
    assert.equal(signal.hasIntentMarker, true);
    assert.equal(signal.hasDeliverableVerb, true);
  });

  test('NO leaked content — signal exposes only structural fields', () => {
    const signal = deferralNearMissSignal('让我处理一下。');
    assert.ok(signal);
    const keys = Object.keys(signal).sort();
    assert.deepEqual(keys, ['hasDeliverableVerb', 'hasIntentMarker', 'reason', 'tailLen']);
    assert.equal(typeof signal.tailLen, 'number');
    assert.equal(typeof signal.hasIntentMarker, 'boolean');
    assert.equal(typeof signal.hasDeliverableVerb, 'boolean');
    // `reason` is the ONLY string field and is a fixed enum, never raw user content
    assert.ok(['no_deliverable_verb', 'content_after_verb'].includes(signal.reason));
  });

  test('confirmed deferral (predicate fires) → null, not a near-miss', () => {
    assert.equal(deferralNearMissSignal('让我整理分析。'), null);
  });

  test('colon-delivered inline content → null (real answer, not a miss)', () => {
    assert.equal(deferralNearMissSignal('我来总结：方案 A 最优。'), null);
  });

  test('no first-person intent marker → null (not future-action shaped)', () => {
    assert.equal(deferralNearMissSignal('方案 A 最优。'), null);
  });

  test('long substantive tail with a marker → null (not short, clearly delivered)', () => {
    assert.equal(
      deferralNearMissSignal('让我来详细说明：首先考虑成本，其次质量，最后时间，三者平衡后最优解是方案 A 而不是 B。'),
      null,
    );
  });

  test('empty / whitespace / nullish → null', () => {
    assert.equal(deferralNearMissSignal(''), null);
    assert.equal(deferralNearMissSignal('   '), null);
    assert.equal(deferralNearMissSignal(undefined), null);
    assert.equal(deferralNearMissSignal(null), null);
  });
});
