import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  gradeSessionRecoveryTrial,
  summarizeSessionRecoveryTrials,
} from '../../dist/infrastructure/harness-eval/session-recovery/index.js';

function trial(assessment) {
  return {
    trialId: 'session-recovery:source-1',
    source: { sessionId: 'source-1', evidenceRef: 'session:source-1' },
    target: { sessionId: 'target-1', evidenceRef: 'session:target-1' },
    lineage: 'explicit',
    transitionIntegrity: 'pass',
    delivery: 'provider_dispatched',
    structuralIssues: [],
    evidenceRefs: ['session:source-1', 'session:target-1', 'invocation:inv-1'],
    ...(assessment ? { assessment } : {}),
  };
}

describe('session recovery deterministic grader', () => {
  it('keeps semantic dimensions unknown without cat assessment', () => {
    assert.deepEqual(gradeSessionRecoveryTrial(trial()), {
      structural: 'pass',
      semantic: 'unknown',
      stateReconstruction: 'unknown',
      firstMeaningfulAction: 'unknown',
      outcome: 'unknown',
      issues: [],
    });
  });

  it('grades clean and stale assessments without inspecting transcript text', () => {
    const clean = trial({
      trialId: 'session-recovery:source-1',
      stateReconstruction: 'recovered',
      firstMeaningfulAction: 'aligned',
      outcome: 'continued',
      evidenceRefs: ['invocation:inv-1'],
      rationale: 'checked live truth',
    });
    const stale = trial({
      ...clean.assessment,
      stateReconstruction: 'stale',
      firstMeaningfulAction: 'misaligned',
      outcome: 'failed',
    });

    assert.equal(gradeSessionRecoveryTrial(clean).semantic, 'pass');
    assert.equal(gradeSessionRecoveryTrial(stale).semantic, 'fail');
    assert.deepEqual(summarizeSessionRecoveryTrials([clean, stale]), {
      total: 2,
      structuralPass: 2,
      structuralFail: 0,
      structuralUnknown: 0,
      semanticPass: 1,
      semanticFail: 1,
      semanticUnknown: 0,
    });
  });

  it('never lets a semantic pass erase a structural failure', () => {
    const broken = {
      ...trial({
        trialId: 'session-recovery:source-1',
        stateReconstruction: 'recovered',
        firstMeaningfulAction: 'aligned',
        outcome: 'completed',
        evidenceRefs: ['invocation:inv-1'],
        rationale: 'semantic behavior looked good',
      }),
      transitionIntegrity: 'fail',
      structuralIssues: ['target_identity_mismatch'],
    };

    const grade = gradeSessionRecoveryTrial(broken);
    assert.equal(grade.structural, 'fail');
    assert.equal(grade.semantic, 'pass');
    assert.deepEqual(grade.issues, ['target_identity_mismatch']);
  });
});
