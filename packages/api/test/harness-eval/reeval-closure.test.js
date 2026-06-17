import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transitionReevalClosure } from '../../dist/infrastructure/harness-eval/reeval-closure.js';

const openRecord = {
  handoffId: 'vhp_eval_a2a_2026_05_21_001',
  status: 'open',
  openedAt: '2026-05-21T20:00:00.000Z',
};

describe('re-eval closure loop', () => {
  it('owner response acknowledges but does not resolve a verdict', () => {
    const next = transitionReevalClosure(openRecord, {
      type: 'owner_response',
      ref: 'thread:f167-owner-response',
    });

    assert.equal(next.status, 'acknowledged');
    assert.equal(next.ownerResponseRef, 'thread:f167-owner-response');
  });

  it('owner action moves to acted, not resolved', () => {
    const next = transitionReevalClosure(openRecord, {
      type: 'owner_action',
      ref: 'pr:1234',
    });

    assert.equal(next.status, 'acted');
    assert.equal(next.ownerResponseRef, 'pr:1234');
  });

  it('late owner action does not mutate terminal closure states', () => {
    const terminalRecords = [
      {
        ...openRecord,
        status: 'resolved_by_reeval',
        reevalRef: 'eval:clean-window',
        closureEvidence: 'next eval stayed clean',
      },
      {
        ...openRecord,
        status: 'accepted_suppressed',
        reevalRef: 'thread:cvo-accept',
        closureEvidence: 'operator accepts suppression',
      },
      {
        ...openRecord,
        status: 'escalated',
        closureEvidence: 'SLA elapsed after 48h without owner response',
      },
    ];

    for (const record of terminalRecords) {
      const next = transitionReevalClosure(record, { type: 'owner_action', ref: 'pr:late' });
      assert.deepEqual(next, record);
    }
  });

  it('late owner response does not regress an acted verdict', () => {
    const acted = transitionReevalClosure(openRecord, { type: 'owner_action', ref: 'pr:1234' });
    const next = transitionReevalClosure(acted, {
      type: 'owner_response',
      ref: 'thread:f167-late-comment',
    });

    assert.equal(next.status, 'acted');
    assert.equal(next.ownerResponseRef, 'pr:1234');
  });

  it('re-eval closure cannot close a verdict before owner action', () => {
    const acknowledged = transitionReevalClosure(openRecord, {
      type: 'owner_response',
      ref: 'thread:f167-owner-response',
    });

    for (const record of [openRecord, acknowledged]) {
      const next = transitionReevalClosure(record, {
        type: 'reeval_passed',
        ref: 'docs/harness-feedback/verdicts/reeval.md',
        evidence: 'verdictWithoutPass stayed below threshold for 24h',
      });

      assert.deepEqual(next, record);
    }
  });

  it('subsequent eval evidence can resolve an acted verdict', () => {
    const acted = transitionReevalClosure(openRecord, { type: 'owner_action', ref: 'pr:1234' });
    const resolved = transitionReevalClosure(acted, {
      type: 'reeval_passed',
      ref: 'docs/harness-feedback/verdicts/reeval.md',
      evidence: 'verdictWithoutPass stayed below threshold for 24h',
    });

    assert.equal(resolved.status, 'resolved_by_reeval');
    assert.equal(resolved.reevalRef, 'docs/harness-feedback/verdicts/reeval.md');
  });

  it('operator accept/suppress can close high-impact delete/sunset verdict', () => {
    const acted = transitionReevalClosure(openRecord, { type: 'owner_action', ref: 'pr:1234' });
    const accepted = transitionReevalClosure(acted, {
      type: 'cvo_accept_suppress',
      ref: 'thread:cvo-accept',
      evidence: 'operator accepts sunset risk for obsolete harness',
    });

    assert.equal(accepted.status, 'accepted_suppressed');
    assert.equal(accepted.closureEvidence, 'operator accepts sunset risk for obsolete harness');
  });

  it('closure events do not overwrite terminal audit state', () => {
    const resolved = {
      ...openRecord,
      status: 'resolved_by_reeval',
      reevalRef: 'eval:first-clean-window',
      closureEvidence: 'first clean window',
    };
    const accepted = {
      ...openRecord,
      status: 'accepted_suppressed',
      reevalRef: 'thread:cvo-accept',
      closureEvidence: 'operator accepts suppression',
    };

    assert.deepEqual(
      transitionReevalClosure(resolved, {
        type: 'cvo_accept_suppress',
        ref: 'thread:late-cvo',
        evidence: 'late operator note',
      }),
      resolved,
    );
    assert.deepEqual(
      transitionReevalClosure(accepted, {
        type: 'reeval_passed',
        ref: 'eval:late-clean-window',
        evidence: 'late clean window',
      }),
      accepted,
    );
  });

  it('stale verdict escalates after SLA elapses without owner response', () => {
    const escalated = transitionReevalClosure(openRecord, {
      type: 'sla_elapsed',
      now: '2026-05-23T20:00:00.000Z',
      acknowledgeHours: 24,
    });

    assert.equal(escalated.status, 'escalated');
    assert.match(escalated.closureEvidence, /SLA/);
  });
});
