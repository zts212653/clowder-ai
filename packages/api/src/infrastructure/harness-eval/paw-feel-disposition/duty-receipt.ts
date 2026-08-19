import type {
  PawFeelResponsibilityProjection,
  RichCardBlock,
  RichChecklistBlock,
  RichMessageExtra,
} from '@cat-cafe/shared';
import type { IPawFeelDutyNoticeWatermarkStore, PawFeelDutyBatchSnapshot } from './duty-notice.js';
import { aggregatePawFeelResponsibility } from './responsibility-aggregation.js';

interface CurrentResponsibility {
  signalId: string;
  sequence: number;
  responsibility: PawFeelResponsibilityProjection;
}

interface ReceiptEntry {
  bundleKey: string;
  responsibility: PawFeelResponsibilityProjection;
  memberCount: number;
}

export interface PawFeelDutyReceiptResult {
  outcome: 'no_batch' | 'already_complete' | 'incomplete' | 'complete';
  watermark?: string;
  receiptMessageId?: string;
  validBundleCount?: number;
  bundleCount?: number;
  uncoveredBundleKeys?: string[];
}

export interface PawFeelDutyReceiptServiceOptions {
  watermarkStore: Pick<IPawFeelDutyNoticeWatermarkStore, 'readCurrent' | 'markComplete'>;
  readResponsibilities: (signalIds: readonly string[]) => Promise<CurrentResponsibility[]>;
  updateReceipt: (messageId: string, rich: RichMessageExtra) => Promise<void>;
  now?: () => string;
}

function buildEntries(snapshot: PawFeelDutyBatchSnapshot, current: readonly CurrentResponsibility[]): ReceiptEntry[] {
  const bySignal = new Map(current.map((entry) => [entry.signalId, entry]));
  return snapshot.bundles.map((bundle) => {
    const responsibilities = bundle.members.map((member) => {
      const entry = bySignal.get(member.signalId);
      if (!entry) throw new Error(`duty receipt signal ${member.signalId} is unavailable`);
      return entry.responsibility;
    });
    return {
      bundleKey: bundle.bundleKey,
      responsibility: aggregatePawFeelResponsibility(responsibilities, 'duty receipt bundle has no responsibilities'),
      memberCount: bundle.members.length,
    };
  });
}

function receiptLine(entry: ReceiptEntry): string {
  const state = entry.responsibility.state.replaceAll('_', '-');
  const evidence = entry.responsibility.evidenceRefs.length
    ? ` · evidence ${entry.responsibility.evidenceRefs.join(', ')}`
    : '';
  return `${entry.bundleKey} · ${entry.memberCount} raw · ${state}${evidence}`;
}

export function buildPawFeelDutyReceiptRich(
  watermark: string,
  actorCatId: string,
  entries: readonly ReceiptEntry[],
  generatedAt: string,
): RichMessageExtra {
  const validBundleCount = entries.filter((entry) => entry.responsibility.validExit).length;
  const complete = validBundleCount === entries.length;
  const schedulerOwned = actorCatId.startsWith('scheduler:');
  const card: RichCardBlock = {
    id: 'f278-duty-receipt-summary',
    kind: 'card',
    v: 1,
    title: 'F278 当班责任收据',
    tone: complete ? 'success' : 'danger',
    bodyMarkdown: complete
      ? '本批每个 bundle 均有可核验业务出口。'
      : '本批仍有 bundle 缺少可核验业务出口，watermark 不得完成。',
    fields: [
      { label: 'watermark', value: watermark },
      {
        label: schedulerOwned ? '收据更新者' : '审阅猫',
        value: schedulerOwned ? actorCatId : `@${actorCatId}`,
      },
      { label: '业务出口', value: `${validBundleCount}/${entries.length}` },
      { label: '生成时间', value: generatedAt },
    ],
    meta: { kind: 'paw_feel_duty_receipt', watermark, complete },
  };
  const checklist: RichChecklistBlock = {
    id: 'f278-duty-receipt-bundles',
    kind: 'checklist',
    v: 1,
    title: '逐 bundle 业务真相',
    items: entries.map((entry, index) => ({
      id: `bundle-${index + 1}`,
      text: receiptLine(entry),
      checked: entry.responsibility.validExit,
    })),
  };
  return { v: 1, blocks: [card, checklist] };
}

export class PawFeelDutyReceiptService {
  private readonly now: () => string;

  constructor(private readonly options: PawFeelDutyReceiptServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcile(actorCatId: string): Promise<PawFeelDutyReceiptResult> {
    const batch = await this.options.watermarkStore.readCurrent();
    if (!batch) return { outcome: 'no_batch' };
    if (batch.status === 'complete') return { outcome: 'already_complete', watermark: batch.watermark };
    if (batch.status !== 'awaiting_receipt' || !batch.messageId) {
      return { outcome: 'incomplete', watermark: batch.watermark, uncoveredBundleKeys: [] };
    }
    const signalIds = batch.snapshot.bundles.flatMap((bundle) => bundle.members.map((member) => member.signalId));
    const current = await this.options.readResponsibilities(signalIds);
    const entries = buildEntries(batch.snapshot, current);
    const uncoveredBundleKeys = entries
      .filter((entry) => !entry.responsibility.validExit)
      .map((entry) => entry.bundleKey);
    const resultBase = {
      watermark: batch.watermark,
      validBundleCount: entries.length - uncoveredBundleKeys.length,
      bundleCount: entries.length,
      uncoveredBundleKeys,
    };
    const rich = buildPawFeelDutyReceiptRich(batch.watermark, actorCatId, entries, this.now());
    await this.options.updateReceipt(batch.messageId, rich);
    if (uncoveredBundleKeys.length > 0) return { outcome: 'incomplete', ...resultBase };
    await this.options.watermarkStore.markComplete(batch.watermark, this.now());
    return { outcome: 'complete', receiptMessageId: batch.messageId, ...resultBase };
  }
}
