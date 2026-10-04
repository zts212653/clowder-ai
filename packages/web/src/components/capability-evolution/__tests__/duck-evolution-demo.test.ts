import { describe, expect, it } from 'vitest';
import { calibration, caseInputs, judgeGoal } from '../solution-gate/duck-demo/demo-conditions';
import { comparable, demoRuns } from '../solution-gate/duck-demo/demo-data';

describe('duck story evidence boundaries', () => {
  it('keeps new inputs distinct and rejects partial crossing, accidental crossing and wrong-phase contact', () => {
    const development = new Set(caseInputs.D1.map((x) => JSON.stringify(x)));
    expect(caseInputs.D2.every((x) => !development.has(JSON.stringify(x)))).toBe(true);
    for (const c of calibration) expect(judgeGoal(c.event), c.name).toBe(c.expected);
    const legal = calibration[3].event;
    expect(judgeGoal({ ...legal, crossingTime: 27 })).toBe(false);
    expect(judgeGoal({ ...legal, crossingTime: 10 })).toBe(false);
    expect(judgeGoal({ ...legal, designatedFoot: false })).toBe(false);
    expect(judgeGoal({ ...legal, insideGoal: false })).toBe(false);
  });
  it('compares complete runs under the same measuring conditions, never changed rulers or mismatched loads', () => {
    expect(demoRuns.length).toBe(7);
    expect(comparable(demoRuns[0], demoRuns[1])).toBe(true);
    expect(comparable(demoRuns[0], demoRuns[3])).toBe(false);
    expect(comparable(demoRuns[1], demoRuns[2])).toBe(false);
    expect(comparable(demoRuns[3], demoRuns[4])).toBe(true);
    expect(comparable(demoRuns[4], demoRuns[6])).toBe(false);
    expect(comparable(demoRuns[5], demoRuns[6])).toBe(true);
  });
  it('does not fabricate goal judgments from old contact-only observation or count an aborted run', () => {
    expect(demoRuns.length).toBe(7);
    for (const run of demoRuns) {
      if (run.observation === 'O1') expect(run.goals).toBeNull();
      if (!run.loaded) expect(run.contact).toBeNull();
      run.goals?.forEach((goal, i) => {
        if (goal) expect(run.contact?.[i]).toBe(true);
      });
    }
    expect(demoRuns[0].contact?.filter(Boolean)).toHaveLength(4);
    expect(demoRuns[1].contact?.filter(Boolean)).toHaveLength(5);
    expect(demoRuns[0].contact?.[5]).toBe(true);
    expect(demoRuns[1].contact?.[5]).toBe(false);
  });
});
