/**
 * F257 #6 (slice 6a) — Verdict explanation vocabulary contract (判据 ③).
 *
 * Regression anchors:
 *  - operator screenshot showed `eval(unmeasurable)` with no explanation because the
 *    lifeline UI hard-coded only alive/dormant/retire-candidate.
 *  - sol R1: the vocabulary must equal the frozen SegmentVerdict set (6 terms) and
 *    must NOT mix in the Eval Hub verdict-handoff domain (keep_observe/fix/build/…).
 *
 * The coverage test iterates the SHARED SEGMENT_VERDICTS tuple (not a hand-written
 * list) so a new verdict fails the test — belt-and-suspenders to the compile-time
 * `satisfies Record<SegmentVerdict, …>` in verdict-explanations.ts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SEGMENT_VERDICTS } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { explainVerdict, KNOWN_VERDICTS, VERDICT_EXPLANATIONS } from '../components/settings/verdict-explanations';

const SETTINGS_DIR = path.resolve(__dirname, '..', 'components', 'settings');
const readComponent = (name: string) => readFileSync(path.join(SETTINGS_DIR, name), 'utf-8');

describe('F257 #6: verdict explanations (判据③)', () => {
  it('explains every canonical SegmentVerdict (no gaps vs the shared tuple)', () => {
    for (const v of SEGMENT_VERDICTS) {
      expect(VERDICT_EXPLANATIONS).toHaveProperty(v);
      const e = VERDICT_EXPLANATIONS[v];
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.explanation.length).toBeGreaterThan(0);
    }
  });

  it('KNOWN_VERDICTS is exactly the shared canonical tuple', () => {
    expect([...KNOWN_VERDICTS].sort()).toEqual([...SEGMENT_VERDICTS].sort());
  });

  it('does NOT include the Eval Hub verdict-handoff vocabulary (domain separation)', () => {
    // keep_observe / fix / build / delete_sunset belong to verdict-handoff, not SegmentVerdict.
    for (const wrong of ['keep_observe', 'fix', 'build', 'delete_sunset']) {
      expect(KNOWN_VERDICTS as readonly string[]).not.toContain(wrong);
    }
  });

  it('unmeasurable carries the frozen semantics (无分母, not a cross-domain paraphrase)', () => {
    const e = explainVerdict('unmeasurable');
    expect(e.label).toBe('无分母');
    expect(e.explanation).toContain('分母'); // denominator-based meaning
    expect(e.explanation).toContain('防错杀'); // anti-miskill iron law: must not judge dormant
  });

  it('observability-debt and needs-denominator are explained + distinct (missing in R1)', () => {
    expect(explainVerdict('observability-debt').label.length).toBeGreaterThan(0);
    expect(explainVerdict('needs-denominator').label.length).toBeGreaterThan(0);
    // needs-denominator (fixable) must be distinguished from unmeasurable (no denominator).
    expect(explainVerdict('needs-denominator').label).not.toBe(explainVerdict('unmeasurable').label);
  });

  it('alive is consistent with zero violations — not "violations still have room to decrease" (P2-2)', () => {
    // Producer: injectionCount>0 → alive even when violationCount===0 (segment-judgment-engine).
    const e = explainVerdict('alive');
    expect(e.explanation).not.toContain('下降空间'); // the R1 contradiction, removed
    expect(e.explanation).toMatch(/零违规|违规率/); // acknowledges zero-violation-still-alive
  });

  it('observability-debt does not hardcode the 2-period deadline clock (P2-2)', () => {
    // observabilityDeadline binds to 2 consecutive UNMEASURABLE periods, not to this verdict.
    const e = explainVerdict('observability-debt').explanation;
    expect(e).not.toContain('observabilityDeadline');
    expect(e).not.toContain('2 周期');
  });

  it('needs-denominator references the segment denominator contract, not typed fact (P2-2)', () => {
    const e = explainVerdict('needs-denominator').explanation;
    expect(e).not.toContain('typed fact');
    expect(e).toMatch(/fired-count|session-count/);
  });

  it('null verdict → 未评估, never blank', () => {
    expect(explainVerdict(null).label).toBe('未评估');
    expect(explainVerdict(undefined).explanation.length).toBeGreaterThan(0);
  });

  it('unknown verdict degrades visibly (no silent blank)', () => {
    const e = explainVerdict('some_new_verdict_xyz');
    expect(e.label).toBe('some_new_verdict_xyz');
    expect(e.explanation.length).toBeGreaterThan(0);
  });
});

describe('F257 #6: verdict explanation wiring (判据③)', () => {
  it('LifelineChainView consumes explainVerdict (no hard-coded verdict tone ladder)', () => {
    const src = readComponent('LifelineChainView.tsx');
    expect(src).toContain("from './verdict-explanations'");
    expect(src).toContain('explainVerdict');
    // The old hard-coded verdict→tone branch must be gone (source of the unmeasurable bug).
    expect(src).not.toMatch(/verdict === 'dormant' \|\| epoch\.eval\.verdict === 'retire-candidate'/);
  });

  it('LifelineChainView surfaces the explanation as an eval-badge tooltip', () => {
    const src = readComponent('LifelineChainView.tsx');
    expect(src).toContain('evalTitle');
    expect(src).toMatch(/title\?:\s*string/); // StageBadge accepts a title
    expect(src).toMatch(/title=\{[^}]*title\}/); // eval title flows through (even with the 判据① actionable override)
  });

  it('EvalStagePanel consumes explainVerdict for the 判定 row', () => {
    const src = readComponent('EvalStagePanel.tsx');
    expect(src).toContain("from './verdict-explanations'");
    expect(src).toContain('explainVerdict');
    // The old hard-coded ternary tone must be gone.
    expect(src).not.toMatch(/verdict === 'alive' \? 'emerald'/);
  });
});
