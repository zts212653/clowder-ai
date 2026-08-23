import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyExternalReviewEvent,
  createExternalReviewAggregate,
  decideExternalReviewReadiness,
} from '../dist/domains/community/external-review/external-review-aggregate.js';

const assigned = (overrides = {}) => ({
  mode: 'maintainer_review',
  cloudPolicy: 'required',
  reviewerCatId: 'codex-sol',
  reviewerThreadId: 'thread-f168',
  ...overrides,
});

const event = (kind, payload, at = 1_000) => ({ kind, payload, at });

describe('F168 external review aggregate', () => {
  it('holds one verdict submission on the current generation until canonical readiness arrives', () => {
    let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
    state = applyExternalReviewEvent(
      state,
      event('case.head_observed', { headSha: 'head-pending', headGeneration: 1 }),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.ci_observed', { headSha: 'head-pending', headGeneration: 1, status: 'pending' }),
    ).value;

    const submitted = applyExternalReviewEvent(
      state,
      event('case.review_verdict_submitted', {
        fingerprint: 'verdict-fingerprint',
        headSha: 'head-pending',
        headGeneration: 1,
        verdict: 'approved',
        summary: 'Already reviewed.',
        userNudgeRequired: false,
        delivery: {
          kind: 'delivered',
          headSha: 'head-pending',
          githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-42',
          deliveredAt: 1_000,
        },
        principal: { catId: 'codex-sol', threadId: 'thread-f168' },
        actionLeaseRef: null,
        verificationReason: 'ci_pending',
      }),
    );

    assert.equal(submitted.ok, true);
    assert.equal(submitted.value.lifecycle, 'awaiting_ci');
    assert.equal(submitted.value.pendingVerdict.fingerprint, 'verdict-fingerprint');

    const nextHead = applyExternalReviewEvent(
      submitted.value,
      event('case.head_observed', { headSha: 'head-next', headGeneration: 2 }),
    );
    assert.equal(nextHead.ok, true);
    assert.equal(nextHead.value.pendingVerdict, null, 'a later HEAD must invalidate the pending submission');
  });

  it('invalidates pending reviewer intent when cloud truth becomes blocking or terminally insufficient', () => {
    for (const status of ['blocking', 'failed_or_timeout']) {
      let state = createExternalReviewAggregate(assigned());
      state = applyExternalReviewEvent(
        state,
        event('case.head_observed', { headSha: 'head-cloud', headGeneration: 1 }),
      ).value;
      state = applyExternalReviewEvent(
        state,
        event('case.ci_observed', { headSha: 'head-cloud', headGeneration: 1, status: 'pass' }),
      ).value;
      state = applyExternalReviewEvent(
        state,
        event('case.cloud_review_observed', {
          headSha: 'head-cloud',
          headGeneration: 1,
          status: 'running',
        }),
      ).value;
      state = applyExternalReviewEvent(
        state,
        event('case.review_verdict_submitted', {
          fingerprint: `verdict-${status}`,
          headSha: 'head-cloud',
          headGeneration: 1,
          verdict: 'approved',
          summary: 'Already reviewed.',
          userNudgeRequired: false,
          delivery: {
            kind: 'delivered',
            headSha: 'head-cloud',
            githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-42',
            deliveredAt: 1_000,
          },
          principal: { catId: 'codex-sol', threadId: 'thread-f168' },
          actionLeaseRef: null,
          verificationReason: 'cloud_review_running',
        }),
      ).value;

      const disqualified = applyExternalReviewEvent(
        state,
        event('case.cloud_review_observed', {
          headSha: 'head-cloud',
          headGeneration: 1,
          status,
        }),
      );

      assert.equal(disqualified.ok, true);
      assert.equal(disqualified.value.pendingVerdict, null, `${status} must invalidate prior reviewer intent`);
      assert.equal(
        disqualified.value.verdictSubmissionEpoch,
        1,
        `${status} must advance the durable submission epoch before a later verdict is accepted`,
      );
      const duplicate = applyExternalReviewEvent(
        disqualified.value,
        event('case.cloud_review_observed', { headSha: 'head-cloud', headGeneration: 1, status }, 2_000),
      );
      assert.equal(
        duplicate.value.verdictSubmissionEpoch,
        1,
        `${status} without a new pending intent must not advance the epoch again`,
      );
    }
  });

  it('invalidates current-head CI, cloud, and wake state without rewriting review/delivery history', () => {
    let state = createExternalReviewAggregate(assigned());
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-1' })).value;
    state = applyExternalReviewEvent(
      state,
      event('case.ci_observed', { headSha: 'head-1', status: 'pass' }, 1_100),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.cloud_review_observed', { headSha: 'head-1', status: 'clean', reviewId: 42 }, 1_200),
    ).value;
    state = applyExternalReviewEvent(state, event('case.review_ready', { headSha: 'head-1' }, 1_300)).value;
    state = applyExternalReviewEvent(
      state,
      event('case.reviewer_wake_delivered', { headSha: 'head-1', messageId: 'msg-1' }, 1_400),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event(
        'case.review_verdict_recorded',
        {
          headSha: 'head-1',
          delivery: {
            kind: 'delivered',
            headSha: 'head-1',
            githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-42',
            deliveredAt: 1_500,
          },
        },
        1_500,
      ),
    ).value;

    const changed = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-2' }, 2_000));

    assert.equal(changed.ok, true);
    assert.equal(changed.value.currentHeadSha, 'head-2');
    assert.equal(changed.value.currentHeadObservedAt, 2_000);
    assert.equal(changed.value.lastReviewedHeadSha, 'head-1');
    assert.equal(changed.value.lastDeliveredHeadSha, 'head-1');
    assert.equal(changed.value.ci, null);
    assert.equal(changed.value.cloud, null);
    assert.equal(changed.value.wake, null);
    assert.equal(changed.value.delivery, null);
    assert.equal(changed.value.lifecycle, 'awaiting_ci');
  });

  it('keeps the first observation time when the same HEAD is observed again', () => {
    let state = createExternalReviewAggregate(assigned());
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-1' }, 1_000)).value;
    const duplicate = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-1' }, 2_000));
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.value.currentHeadObservedAt, 1_000);
  });

  it('moves the external-review lifecycle to terminal on merged, closed, or declined events', () => {
    for (const kind of ['pr.merged', 'pr.closed', 'case.declined']) {
      let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
      state = applyExternalReviewEvent(
        state,
        event('case.head_observed', { headSha: 'head-terminal', headGeneration: 1 }),
      ).value;

      const terminal = applyExternalReviewEvent(state, event(kind, {}));

      assert.equal(terminal.ok, true, `${kind} must be consumed by the external-review aggregate`);
      assert.equal(terminal.value.lifecycle, 'terminal');
      assert.equal(terminal.value.currentHeadSha, 'head-terminal');
    }
  });

  it('does not treat a reviewed SHA from an older generation as reviewed after A -> B -> A', () => {
    let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
    state = applyExternalReviewEvent(
      state,
      event('case.head_observed', { headSha: 'head-a', headGeneration: 1 }, 1_000),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.ci_observed', { headSha: 'head-a', headGeneration: 1, status: 'pass' }, 1_100),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.review_ready', { headSha: 'head-a', headGeneration: 1 }, 1_200),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.review_verdict_recorded', {
        headSha: 'head-a',
        headGeneration: 1,
        delivery: {
          kind: 'delivered',
          headSha: 'head-a',
          githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-42',
          deliveredAt: 1_300,
        },
      }),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.head_observed', { headSha: 'head-b', headGeneration: 2 }, 2_000),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.head_observed', { headSha: 'head-a', headGeneration: 3 }, 3_000),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.ci_observed', { headSha: 'head-a', headGeneration: 3, status: 'pass' }, 3_100),
    ).value;

    assert.equal(state.lastReviewedHeadSha, 'head-a');
    assert.equal(state.lastReviewedHeadGeneration, 1);
    assert.deepEqual(decideExternalReviewReadiness(state), { kind: 'ready', headSha: 'head-a' });
  });

  it('requires current-head CI and cloud policy before requesting a reviewer wake', () => {
    let state = createExternalReviewAggregate(assigned());
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-2' })).value;
    state = applyExternalReviewEvent(
      state,
      event('case.ci_observed', { headSha: 'head-2', status: 'pass' }, 1_100),
    ).value;
    state = applyExternalReviewEvent(
      state,
      event('case.cloud_review_observed', { headSha: 'head-2', status: 'running' }, 1_200),
    ).value;

    assert.deepEqual(decideExternalReviewReadiness(state), {
      kind: 'wait',
      reason: 'cloud_review_running',
    });

    state = applyExternalReviewEvent(
      state,
      event('case.cloud_review_observed', { headSha: 'head-2', status: 'clean', reviewId: 43 }, 1_300),
    ).value;
    assert.deepEqual(decideExternalReviewReadiness(state), { kind: 'ready', headSha: 'head-2' });

    state = applyExternalReviewEvent(state, event('case.review_ready', { headSha: 'head-2' }, 1_400)).value;
    assert.deepEqual(decideExternalReviewReadiness(state), {
      kind: 'wait',
      reason: 'wake_already_requested_for_head',
    });
  });

  it('ignores stale-head CI and cloud observations', () => {
    let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-current' })).value;

    const staleCi = applyExternalReviewEvent(state, event('case.ci_observed', { headSha: 'head-old', status: 'pass' }));
    const staleCloud = applyExternalReviewEvent(
      state,
      event('case.cloud_review_observed', { headSha: 'head-old', status: 'clean' }),
    );

    assert.deepEqual(staleCi, { ok: false, reason: 'stale_head' });
    assert.deepEqual(staleCloud, { ok: false, reason: 'stale_head' });
    assert.equal(state.ci, null);
    assert.equal(state.cloud, null);
  });

  it('has no naked verdict branch: delivery proof or persistent pending responsibility is mandatory', () => {
    let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-3' })).value;

    const naked = applyExternalReviewEvent(state, event('case.review_verdict_recorded', { headSha: 'head-3' }));
    assert.deepEqual(naked, { ok: false, reason: 'delivery_outcome_required' });

    const notReady = applyExternalReviewEvent(
      state,
      event('case.review_verdict_recorded', {
        headSha: 'head-3',
        delivery: {
          kind: 'pending_delivery',
          headSha: 'head-3',
          ownerCatId: 'codex-sol',
          reason: 'GitHub rejected the review write',
          createdAt: 2_000,
        },
      }),
    );
    assert.deepEqual(notReady, { ok: false, reason: 'head_not_ready' });

    state = applyExternalReviewEvent(state, event('case.ci_observed', { headSha: 'head-3', status: 'pass' })).value;
    state = applyExternalReviewEvent(state, event('case.review_ready', { headSha: 'head-3' })).value;

    const pending = applyExternalReviewEvent(
      state,
      event('case.review_verdict_recorded', {
        headSha: 'head-3',
        delivery: {
          kind: 'pending_delivery',
          headSha: 'head-3',
          ownerCatId: 'codex-sol',
          reason: 'GitHub rejected the review write',
          createdAt: 2_000,
        },
      }),
    );

    assert.equal(pending.ok, true);
    assert.equal(pending.value.lifecycle, 'pending_delivery');
    assert.equal(pending.value.lastReviewedHeadSha, 'head-3');
    assert.equal(pending.value.lastDeliveredHeadSha, null);
    assert.equal(pending.value.delivery.kind, 'pending_delivery');
  });

  it('never regresses a delivered current HEAD back to pending delivery', () => {
    let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-4' })).value;
    state = applyExternalReviewEvent(state, event('case.ci_observed', { headSha: 'head-4', status: 'pass' })).value;
    state = applyExternalReviewEvent(state, event('case.review_ready', { headSha: 'head-4' })).value;
    state = applyExternalReviewEvent(
      state,
      event('case.review_verdict_recorded', {
        headSha: 'head-4',
        delivery: {
          kind: 'delivered',
          headSha: 'head-4',
          githubUrl: 'https://github.com/acme/widgets/pull/7#issuecomment-42',
          deliveredAt: 2_000,
        },
      }),
    ).value;

    const regressive = applyExternalReviewEvent(
      state,
      event('case.review_verdict_recorded', {
        headSha: 'head-4',
        delivery: {
          kind: 'pending_delivery',
          headSha: 'head-4',
          ownerCatId: 'codex-sol',
          reason: 'A later retry lost its GitHub response',
          createdAt: 3_000,
        },
      }),
    );

    assert.deepEqual(regressive, { ok: false, reason: 'delivery_regression' });
    assert.equal(state.lifecycle, 'delivered');
    assert.equal(state.lastDeliveredHeadSha, 'head-4');
    assert.equal(state.delivery.kind, 'delivered');
  });

  it('repos with no checks: CI pass unblocks readiness so verdict is recordable', () => {
    // Bug reproduction: clowder-ai has no GitHub checks. After CiCdRouter proves
    // an empty rollup is stable for one poll interval, it promotes that observation
    // to pass so readiness can advance without treating the first empty poll as green.
    let state = createExternalReviewAggregate(assigned({ cloudPolicy: 'optional' }));
    state = applyExternalReviewEvent(state, event('case.head_observed', { headSha: 'head-no-ci' })).value;

    // Simulate the settled pass emitted by the poller's empty-rollup stability guard.
    state = applyExternalReviewEvent(state, event('case.ci_observed', { headSha: 'head-no-ci', status: 'pass' })).value;

    // Readiness decision must be 'ready', not 'wait/ci_pending'
    assert.deepEqual(decideExternalReviewReadiness(state), { kind: 'ready', headSha: 'head-no-ci' });

    // review_ready must succeed
    const ready = applyExternalReviewEvent(state, event('case.review_ready', { headSha: 'head-no-ci' }));
    assert.equal(ready.ok, true);
    assert.equal(ready.value.lifecycle, 'rereview_required');

    // Verdict must be recordable (not head_not_ready)
    const verdict = applyExternalReviewEvent(
      ready.value,
      event('case.review_verdict_recorded', {
        headSha: 'head-no-ci',
        delivery: {
          kind: 'delivered',
          headSha: 'head-no-ci',
          githubUrl: 'https://github.com/zts212653/clowder-ai/pull/1342#pullrequestreview-4920606010',
          deliveredAt: 2_000,
        },
      }),
    );
    assert.equal(verdict.ok, true);
    assert.equal(verdict.value.lifecycle, 'delivered');
  });
});
