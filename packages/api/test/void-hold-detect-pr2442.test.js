/**
 * F167 Phase I + F192 D — evaluateVoidHold PR #2442 round-evolution regression
 * suite. Split out of `void-hold-detect.test.js` per cloud R6/R7/R8 P1 (file
 * 350-line hard cap from AGENTS.md). The base Phase I AC-I1 / shouldWarnVoidHold
 * / evaluateVoidHold + 2026-06-20 verdict tests stay in the original file;
 * this one carries the iterative narrowing the PR #2442 review rounds
 * discovered: file-path FPs (cloud R1) → directory refs (R3 P2) → digit-only
 * refs (R5 P2) → provider/path refs (R6 P2) → CJK semantic labels (R7 P2).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateVoidHold } from '../dist/domains/cats/services/agents/routing/void-hold-detect.js';

describe('F167 Phase I + F192 D: evaluateVoidHold — PR #2442 round-evolution', () => {
  const base = {
    lineStartMentions: [],
    structuredTargetCats: [],
    toolNames: [],
  };

  // ── Cloud R1 P2 on PR #2442 — bracketed file path must NOT be stripped as
  //   signature, otherwise narrative `hold_ball` mentions above the path
  //   would re-create the 06-20 FP class. ──

  test('PR #2442 cloud R1 P2: narrative `hold_ball` + bracketed file path [packages/api/src/foo.ts] → no fire', () => {
    const text =
      'I invoked the hold_ball tool earlier this turn to wait for the eval to finish.\n\n[packages/api/src/foo.ts]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'file path must stay in slot, slot has no hold phrase → no fire');
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 cloud R1 P2: narrative `hold_ball` + bracketed short path [src/index.ts] → no fire', () => {
    const text = 'using hold_ball semantics here to wait\n\n[src/index.ts]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  // ── PR #2442 R3 P2 (砚砚): no-extension directory refs must NOT be stripped ──

  test('PR #2442 R3 P2: narrative `hold_ball` + [packages/api] directory ref → no fire', () => {
    const text = 'I mentioned hold_ball as prior tool prose.\n\n[packages/api]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'directory ref stays in slot; slot has no hold phrase → no fire');
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R3 P2: narrative `holdball` + [docs/features] → no fire', () => {
    const text = 'The holdball flow ran earlier this turn.\n\n[docs/features]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  // ── PR #2442 R5 P2 (砚砚 blocking): bracketed digit-bearing refs were
  //   stripped as signatures by the "any digit in RHS" rule, re-exposing
  //   narrative `hold_ball` / `holdball` and recreating C2 FPs. Fix: drop
  //   that branch entirely, rely on the model-name allowlist alone. ──

  test('PR #2442 R5 P2: narrative `hold_ball` + [PR/2442] → no fire (digit alone insufficient)', () => {
    const text = 'I invoked hold_ball earlier to wait for cloud R5.\n\n[PR/2442]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, '[PR/2442] must stay in slot — RHS `2442` is not a model name');
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R5 P2: narrative `holdball` + [issue/123] → no fire', () => {
    const text = 'I will holdball until the issue is triaged.\n\n[issue/123]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R5 P2: narrative `hold_ball` + [F167/Phase2] → no fire', () => {
    const text = 'Going to hold_ball waiting for Phase 2.\n\n[F167/Phase2]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R5 P2: narrative `holdball` + [release/v2] → no fire', () => {
    const text = 'holdball semantics here while we wait\n\n[release/v2]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  // ── PR #2442 R6 P2 (砚砚 blocking): RHS allowlist alone leaks provider/path
  //   on LHS. Fix: require LHS positive identification + RHS allowlist. ──

  test('PR #2442 R6 P2: narrative `hold_ball` + [openai/GPT-5.5] → no fire', () => {
    const text = 'I invoked hold_ball waiting on cloud review.\n\n[openai/GPT-5.5]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, '[openai/GPT-5.5] LHS is provider, not cat — must stay in slot');
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R6 P2: narrative `holdball` + [anthropic/Claude] → no fire', () => {
    const text = 'I will holdball until Anthropic releases the new model.\n\n[anthropic/Claude]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R6 P2: narrative `hold_ball` + [google/Gemini-25] → no fire', () => {
    const text = 'Going to hold_ball while waiting for Google.\n\n[google/Gemini-25]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R6 P2: narrative `holdball` + [docs/Sonnet] → no fire', () => {
    const text = 'holdball flow doc lives somewhere.\n\n[docs/Sonnet]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R6 P2: narrative `hold_ball` + [models/Opus-4.7] → no fire', () => {
    const text = 'hold_ball was the prior tool used.\n\n[models/Opus-4.7]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R6 P2: narrative `hold_ball` + [api/Codex] → no fire', () => {
    const text = 'hold_ball semantics here while waiting.\n\n[api/Codex]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R6 P2: narrative `holdball` + [apache/Spark] → no fire', () => {
    const text = 'The holdball pattern shows up in Spark too.\n\n[apache/Spark]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  // Positive control — CJK LHS + model RHS still strips.

  test('PR #2442 R6 P2: positive control — narrative `hold_ball` + [宪宪/Opus-46] CJK fires', () => {
    const text = 'Going to hold_ball until the eval finishes.\n\n[宪宪/Opus-46]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_hold_ball_underscore');
  });

  // ── PR #2442 R7 P2 (砚砚 blocking): broad CJK LHS regex admitted Chinese
  //   semantic labels (`模型` / `文档` / `供应商` / ...). Fix: precise nickname
  //   allowlist 宪宪 | 砚砚 | 烁烁. ──

  test('PR #2442 R7 P2: narrative `hold_ball` + [模型/GPT-5.5] → no fire', () => {
    const text = 'I invoked hold_ball waiting on the model upgrade.\n\n[模型/GPT-5.5]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, '[模型/GPT-5.5] LHS `模型` not a nickname — must stay in slot');
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R7 P2: narrative `holdball` + [文档/Sonnet] → no fire', () => {
    const text = 'I will holdball reading the docs.\n\n[文档/Sonnet]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R7 P2: narrative `hold_ball` + [供应商/Claude] → no fire', () => {
    const text = 'Going to hold_ball waiting for vendor confirmation.\n\n[供应商/Claude]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R7 P2: narrative `holdball` + [路径/Opus-4.7] → no fire', () => {
    const text = 'holdball was the prior tool.\n\n[路径/Opus-4.7]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R7 P2: narrative `hold_ball` + [章节/Pro] → no fire', () => {
    const text = 'hold_ball semantics covered earlier this chapter.\n\n[章节/Pro]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R7 P2: narrative `holdball` + [发布/Gemini-25] → no fire', () => {
    const text = 'holdball flow for the release.\n\n[发布/Gemini-25]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('PR #2442 R7 P2: narrative `hold_ball` + [工具/Codex] → no fire', () => {
    const text = 'hold_ball is the harness tool here.\n\n[工具/Codex]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  // Positive controls — precise nickname allowlist still catches all 3 canonical.

  test('PR #2442 R7 P2: positive control — `hold ball` + [砚砚/GPT-5.5] fires', () => {
    const text = 'Going to hold ball waiting for review.\n\n[砚砚/GPT-5.5]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_holdball_space');
  });

  test('PR #2442 R7 P2: positive control — `hold_ball` + [烁烁/Gemini-25] fires', () => {
    const text = 'I will hold_ball until the eval completes.\n\n[烁烁/Gemini-25]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_hold_ball_underscore');
  });
});
