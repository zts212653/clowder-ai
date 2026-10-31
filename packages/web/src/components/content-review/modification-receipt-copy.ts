import { type ContentModificationReceiptV1, contentModificationReceiptV1Schema } from '@cat-cafe/shared';
import type { ModificationLineCopy } from './modification-progress-copy';

/**
 * Interface wording for the Host receipts that land in a conversation (candidate, rejection, write-back, and the
 * media approve / request-changes verdicts).
 * Wording follows the accepted Studio state board (north-star §1.3 S7): 采用并写回 is only reported once the
 * receipt says so, a conflict and an unconfirmed result each say exactly that, and a rejection says the file did
 * not change. The raw message text the server stores (with request, candidate and receipt coordinates) is never
 * shown; this is what the reader sees instead.
 */
export interface ModificationReceiptInput {
  receipt: ContentModificationReceiptV1;
  /** The named cat that returned the change; unknown is stated plainly rather than guessed. */
  targetName?: string;
}

/**
 * The receipt of a Host message, or null when the carrier is absent or not a valid Host receipt. The Host identity
 * is the systemKind AND a schema-valid payload, exactly as the server decides it (`catConsumableHostSpeaker`); a
 * payload alone never lets another system message hide its text behind a receipt line.
 */
export function contentModificationReceiptOf(extra: unknown): ContentModificationReceiptV1 | null {
  const carrier = extra as { systemKind?: unknown; contentModificationReceiptV1?: unknown } | null | undefined;
  if (carrier?.systemKind !== 'content_modification_receipt') return null;
  const parsed = contentModificationReceiptV1Schema.safeParse(carrier.contentModificationReceiptV1);
  return parsed.success ? parsed.data : null;
}

const openComparison = { kind: 'open-comparison', label: '打开对照', compactLabel: '打开对照' } as const;
const openFile = { kind: 'open-file', label: '打开文件', compactLabel: '打开文件' } as const;

export function describeModificationReceipt({ receipt, targetName }: ModificationReceiptInput): ModificationLineCopy {
  // The server only reports a wake when the queue really started the cat; anything else says nothing about one.
  const woken = receipt.followUp.kind === 'cat_woken' && targetName ? `已通知${targetName}继续处理。` : '';
  const withWake = (detail: string) => (woken ? `${detail}${woken}` : detail);
  switch (receipt.state) {
    case 'candidate':
      return {
        key: 'receipt_candidate',
        indicator: 'neutral',
        title: targetName ? `${targetName}提交了修改` : '收到一份修改',
        detail: '原文件尚未因此改变。',
        action: openComparison,
      };
    case 'rejected':
      return {
        key: 'receipt_rejected',
        indicator: 'neutral',
        title: '未采用',
        detail: '修改和讨论已保留，原文件未变。',
        action: openComparison,
      };
    case 'applied':
      return {
        key: 'receipt_applied',
        indicator: 'success',
        title: '已写回',
        detail: '修改已采用并写回原文件。',
        action: openFile,
      };
    // The two media verdicts hand a decision back to the original task and nothing else: no file is written, the
    // task is not declared done, and no cat is woken (the schema keeps their follow-up at none). So neither says
    // 已写回 / 已采用 / 已通知, and both open the comparison rather than the file.
    case 'approved':
      return {
        key: 'receipt_approved',
        indicator: 'success',
        title: '已通过',
        detail: '结论已交还原任务；不代表任务完成，也没有写回文件。',
        action: openComparison,
      };
    case 'changes_requested':
      return {
        key: 'receipt_changes_requested',
        indicator: 'neutral',
        title: '已要求修改',
        detail: '已交还原任务；修改和讨论已保留。',
        action: openComparison,
      };
    case 'conflict':
      return {
        key: 'receipt_conflict',
        indicator: 'attention',
        title: '未写回：原文件已更改',
        detail: withWake('修改已保留，未覆盖原文件。'),
        action: openComparison,
      };
    case 'unknown':
      return {
        key: 'receipt_unknown',
        indicator: 'attention',
        title: '写回结果未确认',
        detail: withWake('修改已保留，请核对原文件。'),
        action: openFile,
      };
  }
}
