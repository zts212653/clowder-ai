import type { UnifiedAttentionView } from '../use-unified-attention';
import type { HandledHistorySnapshot } from './handled-history-read';

/** A missing producer is never an empty history. Cached rows remain display-only. */
export function historyReadState(tab: string, snapshot: HandledHistorySnapshot | null, view: UnifiedAttentionView) {
  const approvals = tab === 'all' || tab === 'decisions';
  const attention = tab !== 'decisions';
  const read = view.result.kind === 'ok' ? view.result.read : view.staleRead;
  const sources = !read
    ? []
    : tab === 'ignored'
      ? Object.values(read.sources)
      : [read.sources.userMentions, read.sources.personalPreferences];
  const attentionReady =
    view.result.kind === 'ok' &&
    !!read &&
    read.consistency.state === 'verified' &&
    sources.length > 0 &&
    sources.every((source) => source?.status === 'available' && source.exhaustiveness === 'complete');
  const approvalReady = snapshot?.status === 'ready';
  const reading =
    (approvals && (!snapshot || ['idle', 'reading', 'preparing'].includes(snapshot.status))) ||
    (attention && view.result.kind === 'loading');
  const failed =
    (approvals && snapshot?.status === 'unavailable') ||
    (attention && view.result.kind !== 'loading' && !attentionReady);
  const timestamps = [approvals ? snapshot?.observedAt : null, attention ? read?.observedAt : null].filter(
    (at): at is number => typeof at === 'number',
  );
  return {
    reading,
    failed,
    observedAt: timestamps.length ? Math.min(...timestamps) : null,
    canClaimEmpty: (!approvals || approvalReady) && (!attention || attentionReady),
  };
}
