import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPawFeelDutyReceiptRich,
  PawFeelDutyReceiptService,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/duty-receipt.js';

const NOW = '2026-08-08T12:00:00.000Z';

function batch() {
  return {
    watermark: 'watermark-1',
    status: 'awaiting_receipt',
    updatedAt: NOW,
    messageId: 'notice-1',
    snapshot: {
      bundles: [
        { bundleKey: 'bundle:a', members: [{ signalId: 'signal-a', expectedSequence: 1 }] },
        { bundleKey: 'bundle:b', members: [{ signalId: 'signal-b', expectedSequence: 1 }] },
      ],
    },
  };
}

function terminal(reason = 'not_actionable') {
  return {
    state: 'terminal',
    validExit: true,
    exitKind: 'terminal_disposition',
    evidenceRefs: [reason],
  };
}

function fixture(responsibilities) {
  const current = batch();
  const receipts = [];
  const store = {
    async readCurrent() {
      return structuredClone(current);
    },
    async markComplete(watermark, updatedAt) {
      assert.equal(watermark, current.watermark);
      current.status = 'complete';
      current.updatedAt = updatedAt;
    },
  };
  return {
    current,
    receipts,
    service: new PawFeelDutyReceiptService({
      watermarkStore: store,
      readResponsibilities: async () => responsibilities,
      updateReceipt: async (messageId, rich) => receipts.push({ messageId, rich }),
      now: () => NOW,
    }),
  };
}

describe('F278 duty business receipt', () => {
  it('keeps the batch open while any exact snapshot bundle is still unreviewed', async () => {
    const test = fixture([
      { signalId: 'signal-a', sequence: 2, responsibility: terminal() },
      {
        signalId: 'signal-b',
        sequence: 1,
        responsibility: {
          state: 'unreviewed',
          validExit: false,
          exitKind: 'repair_binding',
          evidenceRefs: ['task-stale', 'lease-stale'],
        },
      },
    ]);

    const result = await test.service.reconcile('opus5');

    assert.deepEqual(result, {
      outcome: 'incomplete',
      watermark: 'watermark-1',
      validBundleCount: 1,
      bundleCount: 2,
      uncoveredBundleKeys: ['bundle:b'],
    });
    assert.equal(test.current.status, 'awaiting_receipt');
    assert.equal(test.receipts.length, 1);
    assert.equal(test.receipts[0].messageId, 'notice-1');
    const [card, checklist] = test.receipts[0].rich.blocks;
    assert.equal(card.kind, 'card');
    assert.equal(card.tone, 'danger');
    assert.equal(card.meta.complete, false);
    assert.equal(checklist.kind, 'checklist');
    assert.equal(checklist.items[0].checked, true);
    assert.equal(checklist.items[1].checked, false);
    assert.match(checklist.items[1].text, /unreviewed.*task-stale.*lease-stale/);
  });

  it('labels scheduler reconciliation as system receipt maintenance, not cat review', () => {
    const rich = buildPawFeelDutyReceiptRich(
      'wm-1',
      'scheduler:paw-feel-disposition-duty',
      [
        {
          bundleKey: 'bundle:a',
          memberCount: 1,
          responsibility: { state: 'unreviewed', validExit: false, exitKind: 'none', evidenceRefs: [] },
        },
      ],
      NOW,
    );

    const actorField = rich.blocks[0].fields.find((field) => field.label === '收据更新者');
    assert.deepEqual(actorField, {
      label: '收据更新者',
      value: 'scheduler:paw-feel-disposition-duty',
    });
    assert.equal(
      rich.blocks[0].fields.some((field) => field.label === '审阅猫'),
      false,
    );
  });

  it('keeps a recoverable signature request open until an independent signer finishes it', async () => {
    const test = fixture([
      { signalId: 'signal-a', sequence: 2, responsibility: terminal() },
      {
        signalId: 'signal-b',
        sequence: 2,
        responsibility: {
          state: 'signature_waiting',
          validExit: false,
          exitKind: 'signature_request',
          evidenceRefs: ['signature-request-1'],
          signerExclusionCatId: 'codex-sol',
          preferredSignerCatId: 'opus5',
        },
      },
    ]);

    const result = await test.service.reconcile('opus5');

    assert.deepEqual(result, {
      outcome: 'incomplete',
      watermark: 'watermark-1',
      validBundleCount: 1,
      bundleCount: 2,
      uncoveredBundleKeys: ['bundle:b'],
    });
    assert.equal(test.current.status, 'awaiting_receipt');
    assert.equal(test.receipts.length, 1);
    assert.equal(test.receipts[0].rich.blocks[0].meta.complete, false);
  });

  it('updates the durable notice with a checked rich receipt before completing the watermark', async () => {
    const test = fixture([
      { signalId: 'signal-a', sequence: 2, responsibility: terminal() },
      { signalId: 'signal-b', sequence: 3, responsibility: terminal('signature-request-1:independent-signature') },
    ]);

    const result = await test.service.reconcile('opus5');

    assert.equal(result.outcome, 'complete');
    assert.equal(result.receiptMessageId, 'notice-1');
    assert.equal(test.current.status, 'complete');
    assert.equal(test.receipts.length, 1);
    assert.equal(test.receipts[0].messageId, 'notice-1');
    const [card, checklist] = test.receipts[0].rich.blocks;
    assert.equal(card.kind, 'card');
    assert.equal(card.meta.complete, true);
    assert.equal(checklist.kind, 'checklist');
    assert.equal(checklist.items.length, 2);
    assert.equal(
      checklist.items.every((item) => item.checked),
      true,
    );
    assert.match(checklist.items[1].text, /terminal.*signature-request-1:independent-signature/);

    const replay = await test.service.reconcile('opus5');
    assert.deepEqual(replay, { outcome: 'already_complete', watermark: 'watermark-1' });
    assert.equal(test.receipts.length, 1);
  });
});
