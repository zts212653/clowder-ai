import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { contentModificationReceiptOf, describeModificationReceipt } from '../modification-receipt-copy';

type State = ContentModificationReceiptV1['state'];
type FollowUp = ContentModificationReceiptV1['followUp'];

const REQUEST_ID = `f309-modification-${'a'.repeat(64)}`;

function receipt(state: State, followUp: FollowUp = { kind: 'none', reason: 'not_applicable' }) {
  return {
    v: 1,
    requestId: REQUEST_ID,
    sourceMessageId: 'human-source',
    targetCatId: 'codex-sol',
    taskId: 'task-1',
    state,
    ...(state === 'unknown' ? {} : { candidateRef: 'candidate-1' }),
    receiptRef: 'receipt-1',
    observedAt: 1,
    followUp,
  } as ContentModificationReceiptV1;
}

describe('describeModificationReceipt — accepted Studio state board wording', () => {
  it('says a candidate came back and that the original file has not changed', () => {
    expect(describeModificationReceipt({ receipt: receipt('candidate'), targetName: '烁烁' })).toMatchObject({
      key: 'receipt_candidate',
      indicator: 'neutral',
      title: '烁烁提交了修改',
      detail: '原文件尚未因此改变。',
      action: { kind: 'open-comparison', label: '打开对照' },
    });
  });

  it('only claims a write-back when the receipt says it was applied', () => {
    expect(describeModificationReceipt({ receipt: receipt('applied'), targetName: '烁烁' })).toMatchObject({
      key: 'receipt_applied',
      indicator: 'success',
      title: '已写回',
      detail: '修改已采用并写回原文件。',
      action: { kind: 'open-file', label: '打开文件' },
    });
  });

  it('keeps a conflict visibly different from an applied write-back', () => {
    const copy = describeModificationReceipt({ receipt: receipt('conflict'), targetName: '烁烁' });
    expect(copy).toMatchObject({
      key: 'receipt_conflict',
      indicator: 'attention',
      title: '未写回：原文件已更改',
      detail: '修改已保留，未覆盖原文件。',
      action: { kind: 'open-comparison' },
    });
    expect(`${copy.title}${copy.detail}`).not.toMatch(/已写回原|已采用/);
  });

  it('does not guess when the write-back result cannot be confirmed', () => {
    const copy = describeModificationReceipt({ receipt: receipt('unknown'), targetName: '烁烁' });
    expect(copy).toMatchObject({
      key: 'receipt_unknown',
      indicator: 'attention',
      title: '写回结果未确认',
      detail: '修改已保留，请核对原文件。',
      action: { kind: 'open-file', label: '打开文件' },
    });
    expect(`${copy.title}${copy.detail}`).not.toMatch(/已写回|成功/);
  });

  it('keeps a rejected candidate reachable and says the file did not change', () => {
    expect(describeModificationReceipt({ receipt: receipt('rejected'), targetName: '烁烁' })).toMatchObject({
      key: 'receipt_rejected',
      indicator: 'neutral',
      title: '未采用',
      detail: '修改和讨论已保留，原文件未变。',
      action: { kind: 'open-comparison' },
    });
  });

  it('says an approved version was handed back to the original task, not that the task is done or the file written', () => {
    const copy = describeModificationReceipt({ receipt: receipt('approved'), targetName: '烁烁' });
    expect(copy).toMatchObject({
      key: 'receipt_approved',
      indicator: 'success',
      title: '已通过',
      detail: '结论已交还原任务；不代表任务完成，也没有写回文件。',
      action: { kind: 'open-comparison', label: '打开对照' },
    });
    // 通过 only hands the verdict back: it must never read as a write-back, an adoption or a wake.
    expect(`${copy.title}${copy.detail}`).not.toMatch(/已写回|已采用|已通知/);
  });

  it('says a change request was handed back and that the discussion is kept', () => {
    const copy = describeModificationReceipt({ receipt: receipt('changes_requested'), targetName: '烁烁' });
    expect(copy).toMatchObject({
      key: 'receipt_changes_requested',
      indicator: 'neutral',
      title: '已要求修改',
      detail: '已交还原任务；修改和讨论已保留。',
      action: { kind: 'open-comparison', label: '打开对照' },
    });
    expect(`${copy.title}${copy.detail}`).not.toMatch(/已写回|已采用|已通知/);
  });

  it('keeps the two media verdicts visibly different from each other and from a write-back', () => {
    const approved = describeModificationReceipt({ receipt: receipt('approved') });
    const changes = describeModificationReceipt({ receipt: receipt('changes_requested') });
    const applied = describeModificationReceipt({ receipt: receipt('applied') });
    expect(new Set([approved.title, changes.title, applied.title]).size).toBe(3);
    expect(new Set([approved.key, changes.key, applied.key]).size).toBe(3);
    // Only a real write-back is green-and-final; an approval is a verdict, so it never opens the file as if written.
    expect(approved.action?.kind).toBe('open-comparison');
  });

  it('describes every receipt state the shared contract can carry', () => {
    // `satisfies` makes a state added to the shared contract a type error here too, not a silent hole in the wording.
    const everyState = {
      candidate: 1,
      rejected: 1,
      applied: 1,
      conflict: 1,
      approved: 1,
      changes_requested: 1,
      unknown: 1,
    } satisfies Record<State, 1>;
    for (const state of Object.keys(everyState) as State[]) {
      const copy = describeModificationReceipt({ receipt: receipt(state), targetName: '烁烁' });
      expect(copy?.key, `state ${state}`).toBe(`receipt_${state}`);
      expect(copy?.title, `state ${state}`).toBeTruthy();
    }
  });

  it('only says the cat was notified when the server confirmed the wake', () => {
    const woken = describeModificationReceipt({
      receipt: receipt('conflict', { kind: 'cat_woken', executionRef: 'message:m#queue-custody' }),
      targetName: '烁烁',
    });
    expect(woken.detail).toBe('修改已保留，未覆盖原文件。已通知烁烁继续处理。');
    for (const followUp of [
      { kind: 'unverified' as const },
      { kind: 'none' as const, reason: 'task_closed' as const },
      { kind: 'none' as const, reason: 'owner_changed' as const },
    ]) {
      const copy = describeModificationReceipt({ receipt: receipt('conflict', followUp), targetName: '烁烁' });
      expect(copy.detail).toBe('修改已保留，未覆盖原文件。');
    }
  });

  it('never mentions a wake for states that do not wake anyone', () => {
    // A candidate, a rejection, an applied receipt and the two media verdicts never start a cat; the schema
    // forbids a follow-up there.
    for (const state of ['candidate', 'rejected', 'applied', 'approved', 'changes_requested'] as const) {
      const copy = describeModificationReceipt({ receipt: receipt(state), targetName: '烁烁' });
      expect(copy.detail).not.toContain('已通知');
    }
  });

  it('falls back to neutral wording when the cat name is unknown', () => {
    expect(describeModificationReceipt({ receipt: receipt('candidate') })).toMatchObject({
      title: '收到一份修改',
    });
  });

  it('never leaks internal coordinates into the words', () => {
    for (const state of [
      'candidate',
      'rejected',
      'applied',
      'conflict',
      'approved',
      'changes_requested',
      'unknown',
    ] as const) {
      const copy = describeModificationReceipt({ receipt: receipt(state), targetName: '烁烁' });
      const words = `${copy.title}${copy.detail ?? ''}${copy.action?.label ?? ''}`;
      expect(words).not.toMatch(/requestId|candidateRef|receiptRef|f309-modification-|candidate-1|receipt-1/);
    }
  });
});

describe('contentModificationReceiptOf', () => {
  it('returns the receipt only when the carrier is a valid Host receipt', () => {
    const valid = receipt('candidate');
    expect(
      contentModificationReceiptOf({ systemKind: 'content_modification_receipt', contentModificationReceiptV1: valid }),
    ).toEqual(valid);
    // The Host identity is the systemKind AND a valid payload (as on the server); a payload alone is not enough.
    expect(contentModificationReceiptOf({ contentModificationReceiptV1: valid })).toBeNull();
    expect(contentModificationReceiptOf({ systemKind: 'a2a_routing', contentModificationReceiptV1: valid })).toBeNull();
    expect(contentModificationReceiptOf(undefined)).toBeNull();
    expect(contentModificationReceiptOf({ systemKind: 'content_modification_receipt' })).toBeNull();
    expect(
      contentModificationReceiptOf({
        systemKind: 'content_modification_receipt',
        contentModificationReceiptV1: { ...valid, state: 'bogus' },
      }),
    ).toBeNull();
    // A receipt that claims a wake for a state that never wakes anyone is rejected by the schema.
    expect(
      contentModificationReceiptOf({
        systemKind: 'content_modification_receipt',
        contentModificationReceiptV1: { ...valid, followUp: { kind: 'cat_woken' } },
      }),
    ).toBeNull();
  });

  it('accepts the two media verdict receipts, and refuses one that claims a wake', () => {
    for (const state of ['approved', 'changes_requested'] as const) {
      const valid = receipt(state);
      expect(
        contentModificationReceiptOf({
          systemKind: 'content_modification_receipt',
          contentModificationReceiptV1: valid,
        }),
        state,
      ).toEqual(valid);
      expect(
        contentModificationReceiptOf({
          systemKind: 'content_modification_receipt',
          contentModificationReceiptV1: { ...valid, followUp: { kind: 'cat_woken' } },
        }),
        `${state} with a wake`,
      ).toBeNull();
    }
  });
});
