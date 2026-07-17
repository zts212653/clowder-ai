import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  gradeSessionRecoveryTrial,
  summarizeSessionRecoveryTrials,
} from '../../dist/infrastructure/harness-eval/session-recovery/index.js';

function trial(assessment) {
  return {
    trialId: 'session-recovery:target-1',
    source: { sessionId: 'source-1', evidenceRef: 'session:source-1' },
    target: { sessionId: 'target-1', evidenceRef: 'session:target-1' },
    evidenceRefs: ['session:source-1', 'session:target-1', 'invocation:inv-1'],
    ...(assessment ? { assessment } : {}),
  };
}

describe('session recovery deterministic grader', () => {
  it('keeps semantic dimensions unknown without cat assessment', () => {
    assert.deepEqual(gradeSessionRecoveryTrial(trial()), {
      semantic: 'unknown',
      stateReconstruction: 'unknown',
      firstMeaningfulAction: 'unknown',
      outcome: 'unknown',
    });
  });

  it('grades clean and stale assessments without inspecting transcript text', () => {
    const clean = trial({
      trialId: 'session-recovery:target-1',
      stateReconstruction: 'recovered',
      firstMeaningfulAction: 'aligned',
      firstMeaningfulEventRef: 'transcript:target-1:event:2',
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
      semanticPass: 1,
      semanticFail: 1,
      semanticUnknown: 0,
    });
  });

  it('keeps the semantic grade unknown until all three outcome dimensions are positive', () => {
    const partial = trial({
      trialId: 'session-recovery:target-1',
      stateReconstruction: 'recovered',
      firstMeaningfulAction: 'unknown',
      outcome: 'continued',
      evidenceRefs: ['invocation:inv-1'],
      rationale: 'The first action could not be established.',
    });
    assert.equal(gradeSessionRecoveryTrial(partial).semantic, 'unknown');
  });
});
