import { createContentFreeFreshnessNotice } from '../../../cats/services/freshness/FreshnessNoticeBroker.js';
import type { LiveInboxReference } from './live-inbox-contract.js';

const rotation: LiveInboxReference['priority'][] = ['urgent', 'urgent', 'urgent', 'normal', 'fyi'];
const lane = (reference: LiveInboxReference) => JSON.stringify([reference.sourceThreadId, reference.authorCatId]);

/** Weighted priority with round-robin producer fairness; normal/FYI cannot starve behind urgent traffic. */
export class LiveInboxFairSelection {
  private position = 0;
  private clock = 0;
  private readonly lastServed = new Map<string, number>();

  take(candidates: LiveInboxReference[], limit: number): LiveInboxReference[] {
    const lanes = new Set(candidates.map(lane));
    for (const key of this.lastServed.keys()) if (!lanes.has(key)) this.lastServed.delete(key);
    const remaining = [...candidates];
    const selected: LiveInboxReference[] = [];
    while (remaining.length && selected.length < limit) {
      const priority = rotation[this.position++ % rotation.length];
      const preferred = remaining.filter((item) => item.priority === priority);
      const eligible = preferred.length ? preferred : remaining;
      eligible.sort(
        (a, b) =>
          (this.lastServed.get(lane(a)) ?? 0) - (this.lastServed.get(lane(b)) ?? 0) ||
          a.order.localeCompare(b.order) ||
          a.messageId.localeCompare(b.messageId),
      );
      const next = eligible[0];
      selected.push(next);
      this.lastServed.set(lane(next), ++this.clock);
      remaining.splice(remaining.indexOf(next), 1);
    }
    return selected;
  }
}

export function liveInboxNotice(threadId: string, references: readonly LiveInboxReference[]): string {
  return (
    `${createContentFreeFreshnessNotice({ threadId, unseenCount: references.length })}\n` +
    '继续无过滤 full 分页直到 hasMore=false；若返回 oversized anchor，沿其 drillDown 走既有 exact full 读取。锚点或通知都不证明已读、已处理或已听见。FYI 可在断点合并说明，用户插话优先。\n' +
    JSON.stringify({
      kind: 'live_inbox_sources',
      sources: references.map((reference) => ({
        messageId: reference.messageId,
        sourceThreadId: reference.sourceThreadId,
        authorCatId: reference.authorCatId,
        priority: reference.priority,
      })),
    })
  );
}
