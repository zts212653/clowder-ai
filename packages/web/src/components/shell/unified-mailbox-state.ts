/**
 * F322 小信箱 — what the one rail entry may claim about the owner's unified attention read (F310).
 *
 * The entry speaks only from what the read proved (home-northstar README §状态, F310 delivery record):
 *  - the badge uses only authority-qualified `attentionCount`; the panel uses `totalCount` — never a sum of
 *    the old per-source counts and never the page's `items.length`;
 *  - "empty" needs a proven complete empty set; zero rows from a source that could not prove full coverage is "partial";
 *  - "needs login" needs an explicit authentication signal; forbidden / not enabled / unreachable is not a login prompt;
 *  - initial loading and failure carry no count. During a same-scope background read, the reader may supply the last
 *    confirmed badge read separately; the current result/generation and all actions still follow the pending read.
 */
import type { UnifiedAttentionReadV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';
import { isMailboxDecision } from './mailbox/mailbox-decision-kind';
import { mailboxEntryCopy } from './mailbox/mailbox-entry.shell-copy';

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
  return deriveReadState(result, 'attentionCount');
}

export function deriveMailboxPanelState(result: MailboxRead): MailboxState {
  return deriveReadState(result, 'totalCount');
}

function deriveReadState(result: MailboxRead, field: 'attentionCount' | 'totalCount'): MailboxState {
  if (result.kind === 'loading') return { kind: 'loading' };
  if (result.kind === 'failed') {
    return result.reason === 'unauthenticated' ? { kind: 'login-required' } : { kind: 'unavailable' };
  }

  const { read } = result;
  const sources = Object.values(read.sources);
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

  const qualifiedSource = read.sources.structuredChoices?.coverage === 'pending_f306_structured_choices';
  // Earlier/handled filters only narrow panel rows; the qualified count remains global.
  const visibleAttention = read.personalView ? read.personalView.visibleAttentionCount : read.attentionCount;
  const attention =
    field === 'totalCount'
      ? exactTotal
      : provenComplete && qualifiedSource && exactTotal !== null && visibleAttention !== undefined
        ? visibleAttention
        : null;
  if (attention === 0) return { kind: 'empty' };
  if (attention !== null && attention > 0) return { kind: 'has-items', count: attention, partial: false };
  const knownRows =
    field === 'totalCount' ? rows > 0 : read.items.some((item) => item.kind === 'approval' || isMailboxDecision(item));
  if (knownRows) {
    return {
      kind: 'has-items',
      count: null,
      partial: !allReadable || read.status !== 'available' || !everyCoverageComplete,
    };
  }
  return { kind: 'partial' };
}

/** Short state phrase used by the tooltip second line and the accessible name — the board's own short words. */
export function mailboxStateText(state: MailboxState, t = mailboxEntryCopy.zh): string {
  switch (state.kind) {
    case 'loading':
      return t.state.loading;
    case 'has-items':
      if (state.count !== null) return t.state.count(state.count);
      return state.partial ? t.state.partialItems : t.state.unconfirmed;
    case 'empty':
      return t.state.empty;
    case 'partial':
      return t.state.partial;
    case 'unavailable':
      return t.state.unavailable;
    case 'login-required':
      return t.state.login;
  }
}

/** One source's own note inside the panel; null when that source was read completely. */
export function sourceStatusText(source: UnifiedAttentionSourceRead, t = mailboxEntryCopy.zh): string | null {
  switch (source.status) {
    case 'unauthenticated':
      return t.source.login;
    case 'forbidden':
      return t.source.forbidden;
    case 'invalid':
      return t.source.invalid;
    case 'unavailable':
      return t.source.unavailable;
    case 'available':
      return source.exhaustiveness === 'complete' ? null : t.source.partial;
  }
}
