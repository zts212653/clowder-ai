import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shouldWarnVerdictWithoutPass } from '../dist/domains/cats/services/agents/routing/verdict-detect.js';

// F167 C2 — PR #2442 round-evolution regression suite. Split out of
// `verdict-detect-slot-scope.test.js` per cloud R6/R7/R8 P1 (file 350-line
// hard cap from AGENTS.md). The base 06-20 verdict + R3 P1 signature tests
// stay in the original file; this one carries the iterative narrowing the
// PR #2442 review rounds discovered: file-path FPs (cloud R1) → directory
// refs (R3 P2) → digit-free signatures (R4) → digit-only refs (R5) →
// provider/path refs (R6) → CJK semantic labels (R7) → terminal body
// brackets (Cloud R4 P2 corroboration).

describe('F167 C2 — PR #2442 round-evolution regression suite (cloud R1 + 砚砚 R3/R4/R5/R6/R7 + Cloud R4 P2)', () => {
  const baseInput = {
    lineStartMentions: [],
    toolNames: [],
    structuredTargetCats: [],
  };

  // ── PR #2442 cloud R1 + 砚砚 R1 P2: bracketed file paths must stay in slot ──

  test('PR #2442 file-path FP: multi-slash [packages/api/src/foo.ts] is NOT stripped', () => {
    // Concrete cloud R1 P2 example: narrative `放行` above + multi-slash
    // path below. Multi-slash content fails the signature check (rule 3),
    // path stays in slot, no verdict word in slot → no fire.
    const text = 'PR #2222 was approved earlier.\n\n[packages/api/src/foo.ts]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 file-path FP: single-slash [src/index.ts] with .ts tail is NOT stripped', () => {
    // Single-slash but `.ts` extension tail fails the signature check
    // (rule 4). Path stays in slot, no verdict word → no fire.
    const text = 'LGTM at first glance.\n\n[src/index.ts]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 file-path FP: [scripts/Foo.json] is NOT stripped (.json extension)', () => {
    const text = '修改建议: rename foo.\n\n[scripts/Foo.json]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 file-path FP boundary check: legacy [宪宪/Opus-4.7] no-paw is NOT mistaken for path', () => {
    // `Opus-4.7` — capital-first matches the known-model-name allowlist
    // (rule 5). Without paw it's still a legacy signature shape per the
    // PR #2314 R6 P1 envelope. This is the key boundary 砚砚 R2 asked to
    // preserve. (Note: lowercase `opus-4.7` is not documented as canonical
    // in commit-signatures.md; pawed lowercase is handled by rule 1 directly.)
    const text = '放行\n\n[宪宪/Opus-4.7]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  // ── PR #2442 R3 P2 (砚砚): no-extension directory refs must NOT be stripped ──

  test('PR #2442 R3 P2: bare directory ref [packages/api] is NOT stripped', () => {
    // Single-slash, no extension, RHS `api` not a model name → rule 5
    // rejects → not a signature → stays in slot → narrative `放行` doesn't fire.
    const text = 'PR #2222 was approved earlier.\n\n[packages/api]';
    assert.equal(
      shouldWarnVerdictWithoutPass({ ...baseInput, text }),
      false,
      'directory ref must stay in slot — would re-create the FP class otherwise',
    );
  });

  test('PR #2442 R3 P2: bare directory ref [docs/features] is NOT stripped', () => {
    const text = 'LGTM, looks clean.\n\n[docs/features]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R3 P2: cat-cafe-skills ref [cat-cafe-skills/refs] is NOT stripped', () => {
    const text = '修改建议：see the skill catalog.\n\n[cat-cafe-skills/refs]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R3 P2: positive control — legacy [砚砚/GPT-5.5] no-paw still strips', () => {
    // Real un-pawed legacy form per PR #2314 R6 P1: cat-name on LHS,
    // model-variant on RHS. `GPT-5.5` matches the rule 5 allowlist
    // (capital GPT + version tail `.5.5`). Production-anchored positive
    // control; hypothetical `[Spark/47]` shape isn't used in real signatures
    // (canonical `Spark` is slashless + pawed via rule 1).
    const text = '放行\n\n[砚砚/GPT-5.5]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  // ── PR #2442 R4 cloud P2: digit-free legacy signatures via model-name allowlist ──

  test('PR #2442 R4 P2: digit-free [宪宪/Sonnet] no-paw is stripped as signature', () => {
    // commit-signatures.md documents `[宪宪/Sonnet🐾]`; un-pawed legacy
    // variant must still be recognized via the model-name allowlist.
    const text = 'LGTM, merging now.\n\n[宪宪/Sonnet]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('PR #2442 R4 P2: digit-free [砚砚/Codex] no-paw is stripped as signature', () => {
    const text = '修改建议: rename foo.\n\n[砚砚/Codex]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('PR #2442 R4 P2: allowlist with version tail [宪宪/Sonnet-4.5] no-paw still strips', () => {
    const text = '放行\n\n[宪宪/Sonnet-4.5]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('PR #2442 R4 P2: allowlist boundary — [apache/spark] lowercase NOT stripped', () => {
    // Common path component shape. RHS `spark` is lowercase → doesn't match
    // capital-first allowlist → stays in slot.
    const text = 'PR was approved earlier.\n\n[apache/spark]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R4 P2: allowlist boundary — [openai/codex] lowercase NOT stripped', () => {
    const text = 'LGTM at first glance.\n\n[openai/codex]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  // ── PR #2442 R5 P2 (砚砚 blocking): rule "digit alone in RHS" was too broad.
  //   Stripped `[PR/2442]` / `[issue/123]` / `[F167/Phase2]` / `[release/v2]`,
  //   exposing prior narrative `放行` / `approved` / `hold_ball` and
  //   re-creating both void-hold and verdict FPs. Fix: drop the digit branch,
  //   rely on the model-name allowlist which already covers every canonical
  //   legacy un-pawed signature. Non-model RHS no longer qualifies.

  test('PR #2442 R5 P2: [PR/2442] is NOT stripped (digit alone insufficient — 砚砚 blocking)', () => {
    const text = '放行延续到下个 head.\n\n[PR/2442]';
    assert.equal(
      shouldWarnVerdictWithoutPass({ ...baseInput, text }),
      false,
      '[PR/2442] must stay in slot — RHS `2442` is not a model name',
    );
  });

  test('PR #2442 R5 P2: [issue/123] is NOT stripped', () => {
    const text = 'approved by 砚砚 earlier.\n\n[issue/123]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R5 P2: [F167/Phase2] is NOT stripped', () => {
    const text = 'P1: handler fix → 放行\n\n[F167/Phase2]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R5 P2: [release/v2] is NOT stripped', () => {
    const text = 'LGTM, merging now.\n\n[release/v2]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  // ── PR #2442 R6 P2 (砚砚 blocking): RHS allowlist alone leaks provider/path
  //   on LHS + model name on RHS. `[openai/GPT-5.5]` / `[anthropic/Claude]` /
  //   `[google/Gemini-25]` / `[docs/Sonnet]` / `[models/Opus-4.7]` /
  //   `[api/Codex]` / `[apache/Spark]`. Fix: add LHS positive identification —
  //   cat nicknames are CJK per commit-signatures.md; provider/path components
  //   are lowercase Latin. Both sides must qualify.

  test('PR #2442 R6 P2: [openai/GPT-5.5] provider+model is NOT stripped (砚砚 blocking)', () => {
    const text = '放行延续到下个 head.\n\n[openai/GPT-5.5]';
    assert.equal(
      shouldWarnVerdictWithoutPass({ ...baseInput, text }),
      false,
      '[openai/GPT-5.5] must stay in slot — LHS `openai` is not a cat nickname',
    );
  });

  test('PR #2442 R6 P2: [anthropic/Claude] provider+model is NOT stripped', () => {
    const text = 'approved by reviewer.\n\n[anthropic/Claude]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R6 P2: [google/Gemini-25] provider+model is NOT stripped', () => {
    const text = '放行\n\n[google/Gemini-25]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R6 P2: [docs/Sonnet] path+model is NOT stripped', () => {
    const text = 'LGTM at first glance.\n\n[docs/Sonnet]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R6 P2: [models/Opus-4.7] path+model is NOT stripped', () => {
    const text = 'P1: handler fix → 放行\n\n[models/Opus-4.7]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R6 P2: [api/Codex] path+model is NOT stripped', () => {
    const text = 'approved by 砚砚 earlier.\n\n[api/Codex]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R6 P2: [apache/Spark] capital-provider+model is NOT stripped (LHS not CJK)', () => {
    // Apache Spark is the project name; even though `Spark` matches the RHS
    // allowlist as a model name, LHS=`apache` is lowercase Latin → not a cat
    // nickname → not a signature.
    const text = '放行\n\n[apache/Spark]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  // Positive controls for R6: verify CJK LHS + model RHS still passes.

  test('PR #2442 R6 P2: positive control — [宪宪/Opus-46] CJK-LHS still strips', () => {
    const text = '放行\n\n[宪宪/Opus-46]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('PR #2442 R6 P2: positive control — [烁烁/Gemini-25] CJK-LHS still strips', () => {
    const text = 'LGTM, merging.\n\n[烁烁/Gemini-25]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  // ── PR #2442 R7 P2 (砚砚 blocking): broad CJK regex `^[一-鿿]+$` was still
  //   too loose — admitted any Chinese semantic label on LHS: `模型` / `文档`
  //   / `供应商` / `路径` / `章节` / `发布` / `工具`. Fix: pin LHS to precise
  //   cat-nickname allowlist 宪宪 | 砚砚 | 烁烁 sourced directly from
  //   commit-signatures.md.

  test('PR #2442 R7 P2: [模型/GPT-5.5] CJK semantic label is NOT stripped (砚砚 blocking)', () => {
    const text = '放行延续到下个 head.\n\n[模型/GPT-5.5]';
    assert.equal(
      shouldWarnVerdictWithoutPass({ ...baseInput, text }),
      false,
      '[模型/GPT-5.5] LHS `模型` (model in Chinese) is not a cat nickname',
    );
  });

  test('PR #2442 R7 P2: [文档/Sonnet] CJK semantic label is NOT stripped', () => {
    const text = 'approved earlier.\n\n[文档/Sonnet]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R7 P2: [供应商/Claude] CJK semantic label is NOT stripped', () => {
    const text = '放行\n\n[供应商/Claude]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R7 P2: [路径/Opus-4.7] CJK semantic label is NOT stripped', () => {
    const text = 'P1: handler fix → 放行\n\n[路径/Opus-4.7]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R7 P2: [章节/Pro] CJK semantic label is NOT stripped', () => {
    const text = 'LGTM at first glance.\n\n[章节/Pro]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R7 P2: [发布/Gemini-25] CJK semantic label is NOT stripped', () => {
    const text = 'PR approved.\n\n[发布/Gemini-25]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  test('PR #2442 R7 P2: [工具/Codex] CJK semantic label is NOT stripped', () => {
    const text = '放行 merging now.\n\n[工具/Codex]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), false);
  });

  // Positive controls for R7: precise nickname allowlist catches all 3.

  test('PR #2442 R7 P2: positive control — [砚砚/GPT-5.5] still strips (precise nickname)', () => {
    const text = '放行\n\n[砚砚/GPT-5.5]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('PR #2442 R7 P2: positive control — [宪宪/Sonnet] still strips (precise nickname)', () => {
    const text = 'LGTM, merging.\n\n[宪宪/Sonnet]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  test('PR #2442 R7 P2: positive control — [烁烁/Gemini-25] still strips (precise nickname)', () => {
    const text = '放行\n\n[烁烁/Gemini-25]';
    assert.equal(shouldWarnVerdictWithoutPass({ ...baseInput, text }), true);
  });

  // Cloud Codex round-4 P2 (2026-06-16) — converges with 砚砚 R6 P1 on the
  // same root cause (over-broad signature regex stripping body brackets).
  // Cloud's specific examples kept in the regression set so future refactors
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
