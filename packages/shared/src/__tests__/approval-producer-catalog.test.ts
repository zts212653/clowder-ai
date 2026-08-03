/**
 * F246 Phase I: one shared producer catalog for API and Web consumers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  APPROVAL_PRODUCER_CATALOG,
  APPROVAL_PRODUCER_IDS,
  approvalProducerMeta,
  validateHumanDispositionFeedbackForProducer,
} from '../approval-producer-catalog.js';
import { HUMAN_DISPOSITION_REASON_CODES } from '../types/human-disposition-feedback.js';

describe('F246 Approval producer catalog', () => {
  it('contains the existing producers plus F276 people memory', () => {
    assert.deepEqual(APPROVAL_PRODUCER_IDS, ['F128', 'F139', 'F225', 'F193', 'F231', 'F260', 'F221', 'F276']);
    assert.equal('F028' in APPROVAL_PRODUCER_CATALOG, false);
    assert.equal('authorization' in APPROVAL_PRODUCER_CATALOG, false);
  });

  it('owns decision routing and source policy metadata', () => {
    assert.equal(approvalProducerMeta('F128').decisionEndpointBase, '/api/proposals');
    assert.equal(approvalProducerMeta('F139').decisionEndpointBase, '/api/schedule-proposals');
    assert.equal(approvalProducerMeta('F139').sourcePolicy, 'message-or-event');
    assert.equal(approvalProducerMeta('F225').decisionEndpointBase, '/api/session-handoff');
    assert.equal(approvalProducerMeta('F193').decisionEndpointBase, '/api/dispatch-proposals');
    assert.equal(approvalProducerMeta('F231').sourcePolicy, 'message-required');
    assert.equal(approvalProducerMeta('F260').sourcePolicy, 'message-or-event');
    assert.equal(approvalProducerMeta('F276').decisionEndpointBase, '/api/person-memory-proposals');
    assert.equal(approvalProducerMeta('F276').sourcePolicy, 'message-required');
    assert.equal(approvalProducerMeta('F276').badgeLabel, 'People');
  });

  it('has non-empty display metadata for every producer', () => {
    for (const producerId of APPROVAL_PRODUCER_IDS) {
      const entry = APPROVAL_PRODUCER_CATALOG[producerId];
      assert.ok(entry.label.trim());
      assert.ok(entry.badgeLabel.trim());
      assert.ok(entry.colorToken.trim());
      assert.ok(entry.decisionEndpointBase.startsWith('/api/'));
      assert.equal(entry.history, true);
    }
  });

  it('enables structured human disposition feedback only for F225 and F276', () => {
    assert.deepEqual(approvalProducerMeta('F225').humanDispositionReasonCodes, HUMAN_DISPOSITION_REASON_CODES);
    assert.deepEqual(approvalProducerMeta('F276').humanDispositionReasonCodes, [
      'not_important',
      'wrong_lane',
      'bad_evidence',
      'wrong',
      'other',
    ]);

    for (const producerId of APPROVAL_PRODUCER_IDS) {
      const reasonCodes = approvalProducerMeta(producerId).humanDispositionReasonCodes;
      if (producerId === 'F225' || producerId === 'F276') {
        assert.ok(reasonCodes);
        assert.ok(reasonCodes.length > 0);
        assert.equal(new Set(reasonCodes).size, reasonCodes.length);
        for (const reasonCode of reasonCodes) assert.ok(HUMAN_DISPOSITION_REASON_CODES.includes(reasonCode));
      } else {
        assert.equal(reasonCodes, null);
      }
    }
  });

  it('uses the catalog tuple as the producer-aware server admission truth', () => {
    for (const reasonCode of HUMAN_DISPOSITION_REASON_CODES) {
      const input = reasonCode === 'other' ? { reasonCode, detail: '需要人工判断' } : { reasonCode };
      assert.deepEqual(validateHumanDispositionFeedbackForProducer('F225', input), {
        success: true,
        data: input,
      });
    }

    assert.deepEqual(validateHumanDispositionFeedbackForProducer('F276', undefined), {
      success: true,
      data: undefined,
    });
    assert.deepEqual(validateHumanDispositionFeedbackForProducer('F276', { reasonCode: 'not_now' }), {
      success: false,
      reason: 'reason_not_allowed',
    });
    assert.deepEqual(validateHumanDispositionFeedbackForProducer('F128', { reasonCode: 'wrong' }), {
      success: false,
      reason: 'feedback_not_enabled',
    });
    assert.deepEqual(validateHumanDispositionFeedbackForProducer('F225', { reasonCode: 'unknown' }), {
      success: false,
      reason: 'invalid_input',
    });
    assert.deepEqual(
      validateHumanDispositionFeedbackForProducer('F225', {
        reasonCode: 'wrong',
        ownerUserId: 'user:spoof',
      }),
      { success: false, reason: 'invalid_input' },
    );
  });
});
