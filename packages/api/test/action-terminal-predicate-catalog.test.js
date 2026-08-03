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
          actionFamily: 'review',
          kind: 'review_delivered',
          completionResolver: 'review_delivery',
          freshnessResolver: 'community_current_head',
          producers: ['external_review_verdict', 'local_review_verdict'],
          requiredPorts: [
            'community_projection',
            'message_store',
            'action_successor_preflight',
            'action_successor_completion',
          ],
        },
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
        community_projection: {},
        message_store: {},
        task_store: {},
        action_successor_preflight: () => {},
        action_successor_completion: () => {},
      },
      completionResolvers: new Set(['review_delivery', 'task_done_status']),
      freshnessResolvers: new Set(['community_current_head', 'task_active_owner']),
      producers: new Set(['external_review_verdict', 'local_review_verdict', 'task_status_transition']),
    };
    assert.doesNotThrow(() => assertActionTerminalCapabilityRegistryReady(ready));
    assert.throws(
      () =>
        assertActionTerminalCapabilityRegistryReady({
          ...ready,
          runtimePorts: { ...ready.runtimePorts, action_successor_completion: undefined },
        }),
      /review:review_delivered requires runtime port action_successor_completion/,
    );
    assert.throws(
      () => assertActionTerminalCapabilityRegistryReady({ ...ready, producers: new Set() }),
      /review:review_delivered requires producer external_review_verdict/,
    );
  });

  it('binds a review predicate to the canonical PR subject without putting HEAD in the action key', () => {
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:Owner/Repo#3018',
      predicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
    });

    assert.equal(predicate.subjectRef, 'pr:owner/repo#3018');
    assert.equal(predicate.identityKey, 'review_delivered\u001fpr:owner/repo#3018');
    assert.equal(predicate.freshnessKey, `head:${FULL_HEAD_SHA}`);
    assert.match(predicate.digest, /^[a-f0-9]{64}$/);
    assert.equal(predicate.identityKey.includes(FULL_HEAD_SHA), false);
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

  it('rejects abbreviated HEADs even when an internal caller bypasses the shared schema', () => {
    assert.throws(
      () =>
        canonicalizeActionTerminalPredicate({
          actionFamily: 'review',
          subjectRef: 'pr:owner/repo#3018',
          predicate: { kind: 'review_delivered', headSha: '405400f406c7' },
        }),
      (error) => error instanceof ActionTerminalPredicateError && error.code === 'invalid_predicate_parameter',
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
      'local-review:message-1:g2:approved',
      'ci:run-9',
      'test:sha256:abc',
      'verdict:message-1',
    ]) {
      assert.equal(isMachineCheckableCompletionEvidenceRef(ref), true, ref);
    }
    for (const ref of [
      'local-review:free-form',
      'queue:dispatch:opus:succeeded',
      'invocation:inv-1',
      'response:looks-good',
      'message:plain',
    ]) {
      assert.equal(isMachineCheckableCompletionEvidenceRef(ref), false, ref);
    }
  });
});
