import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { dispatchProposedActionInputSchema } = await import('@cat-cafe/shared');

const {
  ACTION_TERMINAL_CAPABILITY_REGISTRY,
  ActionTerminalPredicateError,
  assertActionTerminalCapabilityRegistryReady,
  canonicalizeActionTerminalPredicate,
  isMachineCheckableCompletionEvidenceRef,
} = await import('../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js');

const FULL_HEAD_SHA = '4'.repeat(40);

describe('F167 S.1-b ActionTerminalPredicateCatalog', () => {
  it('boots only when every admitted capability has its resolver, producer, and required runtime ports', () => {
    assert.deepEqual(
      ACTION_TERMINAL_CAPABILITY_REGISTRY.map((entry) => ({
        actionFamily: entry.actionFamily,
        kind: entry.kind,
        completionResolver: entry.completionResolver,
        freshnessResolver: entry.freshnessResolver,
        producers: entry.producers,
        requiredPorts: entry.requiredPorts,
      })),
      [
        {
          actionFamily: 'implement',
          kind: 'task_done',
          completionResolver: 'task_done_status',
          freshnessResolver: 'task_active_owner',
          producers: ['task_status_transition'],
          requiredPorts: ['task_store', 'action_successor_completion'],
        },
      ],
    );

    const ready = {
      runtimePorts: {
        task_store: {},
        action_successor_preflight: () => {},
        action_successor_completion: () => {},
      },
      completionResolvers: new Set(['task_done_status']),
      freshnessResolvers: new Set(['task_active_owner']),
      producers: new Set(['task_status_transition']),
    };
    assert.doesNotThrow(() => assertActionTerminalCapabilityRegistryReady(ready));
    assert.throws(
      () =>
        assertActionTerminalCapabilityRegistryReady({
          ...ready,
          runtimePorts: { ...ready.runtimePorts, action_successor_completion: undefined },
        }),
      /implement:task_done requires runtime port action_successor_completion/,
    );
    assert.throws(
      () => assertActionTerminalCapabilityRegistryReady({ ...ready, producers: new Set() }),
      /implement:task_done requires producer task_status_transition/,
    );
  });

  it('binds task completion to one canonical task subject', () => {
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:0001785487739814-000166-1b36feaf',
      predicate: { kind: 'task_done' },
    });

    assert.equal(predicate.subjectRef, 'subject:task:0001785487739814-000166-1b36feaf');
    assert.equal(predicate.identityKey, 'task_done\u001fsubject:task:0001785487739814-000166-1b36feaf');
    assert.equal(predicate.freshnessKey, 'task:0001785487739814-000166-1b36feaf');
    assert.match(predicate.digest, /^[a-f0-9]{64}$/);
  });

  it('rejects the identity-key delimiter at both proposedAction and runtime boundaries', () => {
    const delimiterSubject = 'subject:task:\u001f';
    const proposed = {
      subjectRef: delimiterSubject,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    };

    assert.equal(dispatchProposedActionInputSchema.safeParse(proposed).success, false);
    assert.throws(
      () =>
        canonicalizeActionTerminalPredicate({
          actionFamily: 'implement',
          subjectRef: delimiterSubject,
          predicate: { kind: 'task_done' },
        }),
      (error) => error instanceof ActionTerminalPredicateError && error.code === 'predicate_subject_unsupported',
    );
  });

  it('rejects removed review predicates even when an internal caller bypasses the shared schema', () => {
    assert.throws(
      () =>
        canonicalizeActionTerminalPredicate({
          actionFamily: 'review',
          subjectRef: 'pr:owner/repo#3018',
          predicate: { kind: 'review_delivered', headSha: '405400f406c7' },
        }),
      (error) => error instanceof ActionTerminalPredicateError && error.code === 'predicate_not_allowed',
    );
  });

  it('rejects a sender-selected predicate kind outside the action-family catalog', () => {
    assert.throws(
      () =>
        canonicalizeActionTerminalPredicate({
          actionFamily: 'review',
          subjectRef: 'pr:owner/repo#3018',
          predicate: { kind: 'pr_merged' },
        }),
      (error) => error instanceof ActionTerminalPredicateError && error.code === 'predicate_not_allowed',
    );
  });

  it('rejects predicate kinds without an end-to-end production completion lifecycle', () => {
    const unsupported = [
      ['merge', { kind: 'pr_merged' }],
      ['merge', { kind: 'review_delivered', headSha: '1111111111111111111111111111111111111111' }],
      ['investigate', { kind: 'durable_verdict', verdictRef: 'message-1', freshnessKey: 'v1' }],
      ['implement', { kind: 'durable_verdict', verdictRef: 'message-2', freshnessKey: 'v1' }],
      ['verify', { kind: 'ci_passed', headSha: '1111111111111111111111111111111111111111' }],
      ['verify', { kind: 'test_passed', commandDigest: 'cmd-1', revisionSha: 'abc1234' }],
      ['verify', { kind: 'durable_verdict', verdictRef: 'message-3', freshnessKey: 'v1' }],
      ['vision_guard', { kind: 'durable_verdict', verdictRef: 'message-4', freshnessKey: 'v1' }],
    ];

    for (const [actionFamily, predicate] of unsupported) {
      assert.throws(
        () =>
          canonicalizeActionTerminalPredicate({
            actionFamily,
            subjectRef: 'pr:owner/repo#3019',
            predicate,
          }),
        (error) => error instanceof ActionTerminalPredicateError && error.code === 'predicate_not_allowed',
        `${actionFamily}:${predicate.kind}`,
      );
    }
  });

  it('allows only machine-checkable completion evidence domains', () => {
    for (const ref of [
      'community:pr:owner/repo#3018:review:g2',
      'github:review:123',
      'ci:run-9',
      'test:sha256:abc',
      'verdict:message-1',
    ]) {
      assert.equal(isMachineCheckableCompletionEvidenceRef(ref), true, ref);
    }
    for (const ref of [
      'local-review:free-form',
      'local-review:message-1:g2:approved',
      'queue:dispatch:opus:succeeded',
      'invocation:inv-1',
      'response:looks-good',
      'message:plain',
    ]) {
      assert.equal(isMachineCheckableCompletionEvidenceRef(ref), false, ref);
    }
  });
});
