import type { SettledApprovalItem } from '@cat-cafe/shared';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../utils/settled-history-page.js';

export interface SettledHistoryReader<T> {
  listSettledPage?(
    owner: string,
    options: SettledHistoryPageOptions,
  ): SettledHistorySourcePage<T> | Promise<SettledHistorySourcePage<T>>;
}

/** Projection may omit a tombstone without discarding the physical continuation frontier. */
export async function projectSettledPage<T>(
  store: SettledHistoryReader<T>,
  owner: string,
  options: SettledHistoryPageOptions,
  project: (value: T) => SettledApprovalItem | null | Promise<SettledApprovalItem | null>,
): Promise<SettledHistorySourcePage<SettledApprovalItem>> {
  if (!store.listSettledPage)
    throw Object.assign(new Error('Canonical history page reader unavailable'), {
      statusCode: 503,
      code: 'APPROVAL_HISTORY_UNAVAILABLE',
    });
  const page = await store.listSettledPage(owner, options);
  const outcomes = await Promise.allSettled(page.records.map(project));
  const failed = outcomes.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  const records: SettledApprovalItem[] = [];
  for (const result of outcomes) if (result.status === 'fulfilled' && result.value) records.push(result.value);
  return { ...page, records };
}
