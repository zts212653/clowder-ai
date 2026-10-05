/**
 * F322 小信箱 — what the one rail entry may claim about the owner's unified attention read (F310).
 *
 * The entry speaks only from what the read proved (home-northstar README §状态, F310 delivery record):
 *  - a number appears only when the read itself carries `totalCount`, and it is exactly that number — never a sum of
 *    the old per-source counts and never the page's `items.length`;
 *  - "empty" needs a proven complete empty set; zero rows from a source that could not prove full coverage is "partial";
 *  - "needs login" needs an explicit authentication signal; forbidden / not enabled / unreachable is not a login prompt;
 *  - loading and failure withdraw the earlier claim — nothing here carries a previous number or previous rows.
 */
import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';

/** The user-facing name (1.6 status board: "待办"). The rail entry is still called the mailbox in code and docs. */
export const MAILBOX_NAME = '待办';

/**
 * One attempt's outcome. `unauthenticated` is only the route-level 401; every other failure (403, 5xx, network, a body
 * that is not a version-1 read, an identity that does not match the session) is `unavailable`.
 */
export type MailboxRead =
  | { kind: 'loading' }
  | { kind: 'failed'; reason: 'unauthenticated' | 'unavailable' }
  | { kind: 'ok'; read: UnifiedAttentionReadV1 };

export type MailboxState =
  | { kind: 'loading' }
  /** `count` is null when at least one row is confirmed but no trustworthy total exists ("数量未确认"). */
  | { kind: 'has-items'; count: number | null; partial: boolean }
  | { kind: 'empty' }
  | { kind: 'partial' }
  | { kind: 'unavailable' }
  | { kind: 'login-required' };

export function deriveMailboxState(result: MailboxRead): MailboxState {
  if (result.kind === 'loading') return { kind: 'loading' };
  if (result.kind === 'failed') {
    return result.reason === 'unauthenticated' ? { kind: 'login-required' } : { kind: 'unavailable' };
  }

  const { read } = result;
  const sources = [read.sources.approvals, read.sources.needsMe];
  const readable = sources.filter((source) => source.status === 'available');
  if (readable.length === 0) {
    return sources.every((source) => source.status === 'unauthenticated')
      ? { kind: 'login-required' }
      : { kind: 'unavailable' };
  }

  const allReadable = readable.length === sources.length;
  const everyCoverageComplete = sources.every((source) => source.exhaustiveness === 'complete');
  const provenComplete =
    allReadable && read.status === 'available' && everyCoverageComplete && read.consistency.state === 'verified';
  const rows = read.items.length;
  // A total only counts when the read proved completeness AND it does not contradict the rows already in hand.
  const exactTotal =
    provenComplete && typeof read.totalCount === 'number' && read.totalCount >= rows ? read.totalCount : null;

  if (exactTotal !== null && exactTotal > 0) return { kind: 'has-items', count: exactTotal, partial: false };
  if (rows > 0) {
    return {
      kind: 'has-items',
      count: null,
      partial: !allReadable || read.status !== 'available' || !everyCoverageComplete,
    };
  }
  return exactTotal === 0 ? { kind: 'empty' } : { kind: 'partial' };
}

/** Short state phrase used by the tooltip second line and the accessible name — the board's own short words. */
export function mailboxStateText(state: MailboxState): string {
  switch (state.kind) {
    case 'loading':
      return '读取中';
    case 'has-items':
      if (state.count !== null) return `${state.count} 件`;
      return state.partial ? '仅部分读取 · 已确认有事' : '数量未确认';
    case 'empty':
      return '暂无';
    case 'partial':
      return '仅部分读取';
    case 'unavailable':
      return '暂不可用';
    case 'login-required':
      return '需要登录';
  }
}

export function mailboxAccessibleName(state: MailboxState): string {
  return `${MAILBOX_NAME}，${mailboxStateText(state)}`;
}

/**
 * When the entry says "partial" although no source was left unread, the panel owes the user one line on why
 * (1.6 board, F310 withholds `totalCount`): both sources answered but the two could not be confirmed to agree, so an
 * empty result must not be called "暂无". A source that was not read names itself through `sourceStatusText`, so null here.
 */
export function mailboxPartialNote(read: UnifiedAttentionReadV1): string | null {
  const sources = [read.sources.approvals, read.sources.needsMe];
  if (sources.some((source) => source.status !== 'available')) return null;
  if (read.consistency.state === 'uncertain') return '审批和待处理是分开读的，这次没能确认两边对得上';
  if (sources.some((source) => source.exhaustiveness !== 'complete')) return '这次没能确认两边都读全';
  return null;
}

/** One source's own note inside the panel; null when that source was read completely. */
export function sourceStatusText(source: UnifiedAttentionSourceRead): string | null {
  switch (source.status) {
    case 'unauthenticated':
      return '需要登录';
    case 'forbidden':
      return '无权查看';
    case 'invalid':
      return '无法读取';
    case 'unavailable':
      return '暂不可用';
    case 'available':
      return source.exhaustiveness === 'complete' ? null : '仅部分读取';
  }
}
