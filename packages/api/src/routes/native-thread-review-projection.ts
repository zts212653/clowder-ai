import type { ProviderReviewSemanticEvent } from '@cat-cafe/shared';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ProviderNativeReviewTarget } from '../domains/cats/services/types.js';

export interface NativeReviewProjectionV1 {
  v: 1;
  id: string;
  target: ProviderNativeReviewTarget;
  delivery: 'inline' | 'detached';
  status: 'running' | 'completed' | 'failed' | 'unavailable';
  requestedAt: number;
  updatedAt: number;
  catId?: string;
  reviewThreadId?: string;
  turnId?: string;
  items: Array<{
    id: string;
    kind: 'mode_entered' | 'message' | 'finding' | 'mode_exited';
    text: string;
    completedAt: number;
  }>;
  result?: { status: 'completed' | 'failed'; summary?: string; errorCode?: string };
  unavailableReason?: string;
  truncated?: true;
}

export function projectReviewMessages(messages: readonly StoredMessage[]): NativeReviewProjectionV1[] {
  const groups = new Map<string, ProviderReviewSemanticEvent[]>();
  for (const message of messages) {
    const event = message.extra?.semanticEvent;
    if (event?.kind !== 'review') continue;
    const group = groups.get(event.reviewId) ?? [];
    group.push(event);
    groups.set(event.reviewId, group);
  }
  return [...groups.entries()]
    .map(([reviewId, entries]) => projectReviewGroup(reviewId, entries))
    .filter((review): review is NativeReviewProjectionV1 => review !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function projectReviewGroup(reviewId: string, entries: ProviderReviewSemanticEvent[]): NativeReviewProjectionV1 | null {
  entries.sort((left, right) => left.occurredAt - right.occurredAt);
  const started = entries.find((entry) => entry.stage === 'started');
  const terminal = [...entries].reverse().find((entry) => ['result', 'failed'].includes(entry.stage));
  const anchor = started?.target && started.delivery ? started : terminal;
  if (!anchor?.target || !anchor.delivery) return null;
  const itemEntries = entries.filter((entry) =>
    ['mode_entered', 'progress', 'finding', 'mode_exited'].includes(entry.stage),
  );
  return {
    v: 1,
    id: reviewId,
    target: anchor.target,
    delivery: anchor.delivery,
    ...projectReviewTerminal(terminal),
    requestedAt: started?.occurredAt ?? anchor.requestedAt ?? anchor.occurredAt,
    updatedAt: entries.at(-1)?.occurredAt ?? anchor.occurredAt,
    ...projectReviewIdentity(entries),
    items: itemEntries.map(projectReviewItem),
    ...(terminal && !started ? { truncated: true as const } : {}),
  };
}

function projectReviewTerminal(
  terminal: ProviderReviewSemanticEvent | undefined,
): Pick<NativeReviewProjectionV1, 'status' | 'result'> | Pick<NativeReviewProjectionV1, 'status'> {
  if (!terminal) return { status: 'running' };
  const status = terminal.stage === 'failed' ? 'failed' : 'completed';
  return {
    status,
    result: {
      status,
      summary: terminal.summary,
      ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
    },
  };
}

function projectReviewIdentity(entries: ProviderReviewSemanticEvent[]): Partial<NativeReviewProjectionV1> {
  const catId = entries.find((entry) => entry.actorCatId)?.actorCatId;
  const nativeCoordinate = entries.find((entry) => entry.reviewThreadId && entry.turnId);
  return {
    ...(catId ? { catId } : {}),
    ...(nativeCoordinate?.reviewThreadId ? { reviewThreadId: nativeCoordinate.reviewThreadId } : {}),
    ...(nativeCoordinate?.turnId ? { turnId: nativeCoordinate.turnId } : {}),
  };
}

function projectReviewItem(event: ProviderReviewSemanticEvent): NativeReviewProjectionV1['items'][number] {
  return {
    id: event.id,
    kind: reviewItemKind(event.stage),
    text: event.summary,
    completedAt: event.occurredAt,
  };
}

function reviewItemKind(
  stage: ProviderReviewSemanticEvent['stage'],
): NativeReviewProjectionV1['items'][number]['kind'] {
  if (stage === 'mode_entered') return 'mode_entered';
  if (stage === 'mode_exited') return 'mode_exited';
  if (stage === 'finding') return 'finding';
  return 'message';
}
