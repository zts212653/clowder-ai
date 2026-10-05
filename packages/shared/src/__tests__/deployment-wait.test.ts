import { describe, expect, it } from 'vitest';
import {
  type DeploymentAwaitStateV1,
  type DeploymentObservationV1,
  type DeploymentWaitOutcomeV1,
  deploymentOutcomeMatchesObservation,
  deploymentWaitPredicateSchema,
  evaluateDeploymentWait,
} from '../types/deployment-wait.js';

const revision = 'a'.repeat(40);
const runningRevision = 'b'.repeat(40);
const subjectRef = 'deployment:installation-1:runtime' as const;

function awaiting(when: DeploymentAwaitStateV1['continuation']['when'][number]): DeploymentAwaitStateV1 {
  return {
    v: 1,
    generation: 1,
    subjectRef,
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: { bootSequence: 4, bootId: 'boot-4', capturedAt: 100 },
    // biome-ignore lint/suspicious/noThenProperty: F280's persisted continuation contract uses `then`.
    continuation: { when: [when], then: 'Verify in the original thread' },
    autoRenew: false,
    createdAt: 100,
  };
}

function observed(overrides: Partial<DeploymentObservationV1> = {}): DeploymentObservationV1 {
  return {
    subjectRef,
    bootId: 'boot-5',
    bootSequence: 5,
    runningRevision,
    readyServices: ['api', 'web'],
    observedAt: 200,
    ...overrides,
  };
}

describe('F323 deployment wait evidence', () => {
  it('accepts only the two bounded conditions with a real target and service set', () => {
    expect(
      deploymentWaitPredicateSchema.safeParse({ kind: 'revision_included', revision, services: ['api'] }).success,
    ).toBe(true);
    expect(deploymentWaitPredicateSchema.safeParse({ kind: 'new_ready_boot', services: ['api', 'web'] }).success).toBe(
      true,
    );
    expect(
      deploymentWaitPredicateSchema.safeParse({ kind: 'revision_included', revision: 'main', services: ['api'] })
        .success,
    ).toBe(false);
    expect(deploymentWaitPredicateSchema.safeParse({ kind: 'new_ready_boot', services: [] }).success).toBe(false);
    expect(deploymentWaitPredicateSchema.safeParse({ kind: 'new_ready_boot', services: ['api', 'api'] }).success).toBe(
      false,
    );
    expect(deploymentWaitPredicateSchema.safeParse({ kind: 'config_changed', services: ['api'] }).success).toBe(false);
  });

  it('matches a frozen revision only with proof for the exact target, running build, and ready services', () => {
    const active = awaiting({ kind: 'revision_included', revision, services: ['api', 'web'] });
    const proof = {
      kind: 'git_ancestry' as const,
      targetRevision: revision,
      runningRevision,
      included: true,
    };
    expect(evaluateDeploymentWait(active, observed({ inclusionProof: proof })).state).toBe('matched');
    expect(
      evaluateDeploymentWait(active, observed({ inclusionProof: { ...proof, targetRevision: 'c'.repeat(40) } })).state,
    ).toBe('unknown');
    expect(
      evaluateDeploymentWait(active, observed({ inclusionProof: { ...proof, runningRevision: 'c'.repeat(40) } })).state,
    ).toBe('unknown');
    expect(evaluateDeploymentWait(active, observed({ inclusionProof: { ...proof, included: false } })).state).toBe(
      'waiting',
    );
    expect(evaluateDeploymentWait(active, observed()).state).toBe('unknown');
    expect(
      evaluateDeploymentWait(
        awaiting({ kind: 'revision_included', revision: 'main', services: ['api'] }),
        observed({ inclusionProof: { ...proof, targetRevision: 'main' } }),
      ).state,
    ).toBe('unknown');
  });

  it('never accepts an observation from Alpha, another installation, or an unready service', () => {
    const active = awaiting({ kind: 'revision_included', revision, services: ['api', 'web'] });
    const inclusionProof = {
      kind: 'git_ancestry' as const,
      targetRevision: revision,
      runningRevision,
      included: true,
    };
    expect(
      evaluateDeploymentWait(active, observed({ subjectRef: 'deployment:installation-1:alpha', inclusionProof })).state,
    ).toBe('waiting');
    expect(
      evaluateDeploymentWait(active, observed({ subjectRef: 'deployment:installation-2:runtime', inclusionProof }))
        .state,
    ).toBe('waiting');
    expect(evaluateDeploymentWait(active, observed({ readyServices: ['api'], inclusionProof })).state).toBe('waiting');
  });

  it('uses boot sequence and identity instead of wall clock for new-start waits', () => {
    const active = awaiting({ kind: 'new_ready_boot', services: ['api'] });
    expect(evaluateDeploymentWait(active, observed({ observedAt: 50 })).state).toBe('matched');
    expect(evaluateDeploymentWait(active, observed({ bootId: 'boot-4', bootSequence: 4 })).state).toBe('waiting');
    expect(evaluateDeploymentWait(active, observed({ bootId: 'boot-4', bootSequence: 5 })).state).toBe('unknown');
    expect(evaluateDeploymentWait(active, observed({ bootSequence: 3 })).state).toBe('waiting');
  });

  it('rechecks a consumed revision match against current deployment truth before delivery', () => {
    const active = awaiting({ kind: 'revision_included', revision, services: ['api', 'web'] });
    const inclusionProof = {
      kind: 'git_ancestry' as const,
      targetRevision: revision,
      runningRevision,
      included: true,
    };
    const evaluated = evaluateDeploymentWait(active, observed({ inclusionProof }));
    expect(evaluated.state).toBe('matched');
    if (evaluated.state !== 'matched') throw new Error('fixture did not match');
    const outcome: DeploymentWaitOutcomeV1 = {
      v: 1,
      domain: 'deployment',
      outcomeId: 'outcome-1',
      generation: 1,
      subjectRef,
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      at: 200,
      delivery: 'pending',
      deploymentMatch: evaluated.matched,
    };

    expect(deploymentOutcomeMatchesObservation(outcome, observed({ inclusionProof }))).toBe(true);
    expect(deploymentOutcomeMatchesObservation(outcome, observed({ readyServices: ['api'], inclusionProof }))).toBe(
      false,
    );
    expect(
      deploymentOutcomeMatchesObservation(
        outcome,
        observed({ inclusionProof: { ...inclusionProof, included: false } }),
      ),
    ).toBe(false);
  });

  it('keeps a consumed new-boot match valid only on that boot or a later ready sequence', () => {
    const active = awaiting({ kind: 'new_ready_boot', services: ['api'] });
    const evaluated = evaluateDeploymentWait(active, observed());
    expect(evaluated.state).toBe('matched');
    if (evaluated.state !== 'matched') throw new Error('fixture did not match');
    const outcome: DeploymentWaitOutcomeV1 = {
      v: 1,
      domain: 'deployment',
      outcomeId: 'outcome-boot',
      generation: 1,
      subjectRef,
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      at: 200,
      delivery: 'pending',
      deploymentMatch: evaluated.matched,
    };

    expect(deploymentOutcomeMatchesObservation(outcome, observed())).toBe(true);
    expect(deploymentOutcomeMatchesObservation(outcome, observed({ bootId: 'boot-6', bootSequence: 6 }))).toBe(true);
    expect(deploymentOutcomeMatchesObservation(outcome, observed({ bootId: 'wrong', bootSequence: 5 }))).toBe(false);
    expect(deploymentOutcomeMatchesObservation(outcome, observed({ bootId: 'boot-4', bootSequence: 4 }))).toBe(false);
  });
});
