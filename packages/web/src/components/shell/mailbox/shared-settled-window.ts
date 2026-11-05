import { approvalResultRead } from '@/lib/approval-result-read';
import { retainSettledResult } from './approval-history-page-source';
import { readSettledResults } from './settled-results-source';

export const settledWindowKey = (owner: string) => ({ owner, producer: 'F246', proposalId: 'settled-window:200' });
/** Compatibility display window only. Write confirmation continues to call the original fresh lookup. */
export function readSharedSettledWindow(owner: string, signal?: AbortSignal, fresh = false) {
  return approvalResultRead
    .read(
      settledWindowKey(owner),
      'window',
      async (current) => {
        const observation = approvalResultRead.beginObservation();
        const rows = await readSettledResults(owner, current, 200);
        current.throwIfAborted();
        return Array.isArray(rows) ? rows.map((item) => retainSettledResult(item, observation)) : rows;
      },
      fresh,
    )
    .then((value) => {
      signal?.throwIfAborted();
      return value;
    });
}
