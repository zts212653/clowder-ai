import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shouldWarnVerdictWithoutPass } from '../dist/domains/cats/services/agents/routing/verdict-detect.js';

// F167 C2 — eval:a2a 2026-06-16 actionable fix verdict: C2 verdict_without_pass
// false positives at 6/89 = 6.7%. Root cause: verdict keywords appear in narrative
// body ("X 已放行", "P1: foo 已修", "approved by Y") but the message's final
// routing slot is just a status summary without verdict keywords. Existing exit
// check fires on any body-anywhere match → false positives during in-progress
// review/merge/status updates.
//
// Fix: scope verdict-keyword detection to the final routing slot (reuses Phase H
// `finalRoutingSlot()` from `final-routing-slot.ts`). Same KD-24 mechanical
// approach — narrative body verdicts no longer trigger; verdict-in-slot still
// does. Aligns the C2 check with how Phase H already classifies inline @ —
// "what the cat is finishing the message with" wins, not "what the cat
// mentioned in passing".

describe('F167 C2 — eval:a2a 2026-06-16 verdict-without-pass slot-scope tuning (砚砚 fix verdict)', () => {
  const baseInput = {
    lineStartMentions: [],
    toolNames: [],
    structuredTargetCats: [],
  };

  test('narrative body has 放行 but final slot is status summary → false (in-progress narrative, not a verdict)', () => {
    const text =
      '砚砚 R1 APPROVE on 151604701 — 放行延续到 25b5bd734。\n\n' +
      'Merged at 08:04 UTC. Worktree + branch cleaned.\n\n' +
      '球 cross-post 回 thread_eval_a2a — 砚砚 publish closure verdict 等下个 eval artifact。';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('narrative body has approved + final slot is status (no exit signal) → false', () => {
    const text =
      'PR #2222 was approved by 砚砚 and merged earlier today.\n\n' +
      'Next step: wait for runtime reload + next daily eval artifact.';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('narrative body lists P1: / P2: items + slot is summary → false (list/summary, not new verdict)', () => {
    const text =
      'R1 review summary:\n- P1: extras passthrough → fixed\n- P2: stale comments → fixed\n\n' +
      'Net: 9+5 lines pure formatter style. Will wait for cloud round-2.';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('真正 final verdict in slot (放行 in last paragraph, no exit) → still TRUE (true positive preserved)', () => {
    const text = 'PR 看完了，diff 合理。\n\n放行';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('真正 final verdict in slot (approved alone, no exit) → still TRUE', () => {
    const text = 'Diff looks clean.\n\napproved.';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('真正 final verdict with P1: in slot (no exit) → still TRUE', () => {
    const text = 'Looked at it.\n\nP1: SQL injection in handler — fix before merge.';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('single-paragraph verdict (no narrative body) → still TRUE (whole message = slot)', () => {
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text: '修改建议：重命名 foo' }), true);
  });

  test('narrative body with verdict + slot also has verdict → still TRUE (genuine forgot-to-@)', () => {
    const text = '上一轮 LGTM 完整 + 放行延续到 X。\n\n这一轮也 LGTM，进 merge-gate。';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('narrative body with approved + slot has line-start @ → false (exit valid, not slot-scope)', () => {
    const text = 'PR #2222 was approved earlier.\n\n@codex 请看下一个';
    assert.equal(
      shouldWarnVerdictWithoutPass({
        ...baseInput,
        text,
        lineStartMentions: ['codex'],
      }),
      false,
    );
  });

  test('multi-paragraph: verdict in p1 + verdict in trailing fenced code + verdict-free body slot → false', () => {
    // Phase H finalRoutingSlot strips fenced code; with verdict in p1 but the verdict-free
    // body paragraph as the slot after strip, this is a "quoted-only verdict" case.
    const text = 'PR #2250 已放行。\n\n' + '详情见下面 diff：\n\n' + '```\nsome-code\n放行延续到 abc123\n```';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  // Cloud Codex R3 P1 (2026-06-16): cats follow L0 identity rule to sign with
  // `[昵称/模型🐾]` as a separate final paragraph. With raw `finalRoutingSlot`,
  // `'LGTM\n\n[宪宪/Opus-46🐾]'` returns just the signature → no verdict word →
  // `shouldWarnVerdictWithoutPass` returns false, regressing the previous
  // whole-text scan and letting standard signed verdict-without-pass slip past.
  //
  // Fix: strip trailing cat-signature paragraphs (lines matching `[NAME/MODEL]`
  // bracket pattern, optional 🐾 emoji) before picking the slot.
  test('R3 P1: signature-only last paragraph (LGTM in body) → still TRUE (signature stripped)', () => {
    const text = 'LGTM\n\n[宪宪/Opus-46🐾]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('R3 P1: signature without 🐾 emoji (GPT-5.5 style) still stripped', () => {
    const text = '放行\n\n[砚砚/GPT-5.5]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('R3 P1: multi-paragraph review + verdict in last content paragraph + signature → still TRUE', () => {
    const text =
      'PR diff 看完了，文件改动合理。\n\n' + '修改建议：rename `foo` → `bar` for consistency.\n\n' + '[宪宪/Opus-47🐾]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('R3 P1: signature-only message (no verdict in body) → still false (slot empty after strip)', () => {
    const text = '收到，明白了。\n\n[宪宪/Opus-47🐾]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('R3 P1: bracket-text in body (not trailing) preserved — only TRAILING signatures stripped', () => {
    // Body has bracketed text that looks signature-ish but isn't trailing.
    // Last paragraph is the actual verdict — slot = '放行' → fires.
    const text = '上一轮 [砚砚/GPT-5.4🐾] 已 review。\n\n放行';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('R3 P1: narrative body + status slot + signature → still false (no slot verdict, signature stripped)', () => {
    // Even after signature strip, slot = "Merged at 08:04 UTC..." which has no verdict.
    const text =
      'PR #2222 was approved by 砚砚 earlier.\n\n' +
      'Merged at 08:04 UTC. Worktree + branch cleaned.\n\n' +
      '[宪宪/Opus-47🐾]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  // Cloud Codex R3 P2 (2026-06-16): refs/commit-signatures.md lists slashless
  // cat signatures `[Spark🐾]` and `[烁烁🐾]` for cats whose nickname IS the
  // full identifier. R3 P1 regex required `/` → missed those.
  // Fix: extend regex to ALSO accept `[…🐾]` (paw alone qualifies as signature).
  // Final form after R6 P1 narrowing: `[name/model]` OR `[name🐾]` — body
  // tokens like `[Phase B]` / `[LGTM]` / `[P1: SQL injection]` are NOT
  // signatures and remain in slot. See verdict-detect.ts:45 for the regex.
  test('R3 P2: slashless signature [Spark🐾] (Maine Coon Spark) → still TRUE', () => {
    const text = 'LGTM\n\n[Spark🐾]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('R3 P2: slashless signature [烁烁🐾] (Siamese Gemini) → still TRUE', () => {
    const text = '修改建议：rename foo → bar\n\n[烁烁🐾]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('R6 P1: bare-bracket body tag (no slash, no 🐾) [Phase B] does NOT strip → narrative approved does not fire', () => {
    // 砚砚 R6 P1: previous over-broad regex stripped any single-line bracket token,
    // reintroducing the narrative-body false-positive class this PR is fixing.
    // `[Phase B]` is not a valid cat signature per commit-signatures.md (slashless
    // requires 🐾), so it stays in the slot — slot has no verdict word → no fire.
    const text = 'PR #2222 was approved by 砚砚 earlier.\n\n[Phase B]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('R6 P1: bare-bracket [note] does NOT strip — body-tag boundary preserved', () => {
    const text = 'LGTM, all clear.\n\n[note]';
    // [note] is not a signature → not stripped → slot = '[note]' → no verdict → no fire.
    // (LGTM in body would NOT fire even if [note] WAS stripped, but this test asserts
    // [note] stays put: slot = '[note]' not the LGTM line.)
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('R6 P1: slashed signature WITHOUT 🐾 [砚砚/GPT-5.5] still strips (slash alone qualifies)', () => {
    // commit-signatures.md examples: `[宪宪/Opus-46🐾]` etc. with paw, but the
    // table format `[昵称/变体🐾]` shows paw as the standard suffix. Slashed
    // signatures historically have appeared without paw too — keep them
    // covered since the slash itself is a strong signal.
    const text = '放行\n\n[砚砚/GPT-5.5]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  // Cloud Codex round-4 P2 (2026-06-16) — converges with 砚砚 R6 P1 on the same
  // root cause (over-broad signature regex stripping body brackets). Adding
  // cloud's specific examples to the regression set so future refactors
  // can't silently regress either reviewer's worry.
  test('Cloud P2: bracketed body verdict [LGTM] terminal — preserved → fires (slot=[LGTM])', () => {
    const text = 'Looks correct.\n\n[LGTM]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('Cloud P2: bracketed body verdict [P1: SQL injection] terminal — preserved → fires', () => {
    const text = 'See review.\n\n[P1: SQL injection]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('Cloud P2: bracketed body verdict [P2: nit] terminal — preserved → fires', () => {
    const text = '修了下命名\n\n[P2: nit]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });
});
