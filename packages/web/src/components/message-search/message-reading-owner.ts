import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import type { ChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import {
  type MessageFindContext,
  type MessageFindDestination,
  type MessageFindState,
  parseMessageFindContext,
} from './message-find-state';
import { type MessageReadingSession, startMessageReadingSession } from './message-reading-session';
import {
  beginMessageReadingTrip,
  type MessageReadingEffect,
  requestMessageReadingTarget,
} from './message-reading-trip';
import { verifyMessageNavigationSource } from './verify-message-navigation-source';

export interface PendingReadingOperation {
  sessionId: string;
  effect: MessageReadingEffect;
  running: boolean;
  admitted: boolean;
  direct: boolean;
  refresh: boolean;
  controller: AbortController;
}

export function createPendingOperation(
  sessionId: string,
  effect: MessageReadingEffect,
  options?: { direct?: boolean; refresh?: boolean },
): PendingReadingOperation {
  const direct = Boolean(options?.direct);
  return {
    sessionId,
    effect,
    running: false,
    admitted: direct,
    direct,
    refresh: options?.refresh ?? !direct,
    controller: new AbortController(),
  };
}

export function targetThread(effect: MessageReadingEffect): string {
  return effect.kind === 'target' ? effect.target.threadId : effect.origin.threadId;
}

export async function admitReadingEffect(
  effect: MessageReadingEffect,
  signal: AbortSignal,
): Promise<{ admitted: true; notice: string | null } | { admitted: false; notice: string }> {
  const admission = await verifyMessageNavigationSource(
    effect.kind === 'target' ? effect.target : { threadId: effect.origin.threadId },
    signal,
  );
  if (admission.status !== 'available') {
    return {
      admitted: false,
      notice:
        admission.status === 'forbidden'
          ? '这条来源目前不可访问，已保留返回位置。'
          : '这条来源暂不可定位，已保留返回位置。',
    };
  }
  return {
    admitted: true,
    notice: admission.updated ? '来源已更新，将定位到这条消息的当前版本。' : null,
  };
}

/** Both message trips and destination returns use the original reader's receipts. */
export async function readThroughOwner(
  port: ChatReadingPort,
  effect: MessageReadingEffect,
  signal: AbortSignal,
  options?: { refresh?: boolean },
) {
  const refresh = options?.refresh ?? true;
  if (effect.kind === 'target') {
    const receipt = await port.navigateToMessage(
      effect.target.messageId,
      signal,
      refresh ? { refresh: true } : undefined,
    );
    if (receipt.status !== 'settled') return receipt.status;
    return receipt.threadId === effect.target.threadId && receipt.messageId === effect.target.messageId
      ? ('settled' as const)
      : ('unavailable' as const);
  }
  const receipt = await port.restoreReadingRef(
    effect.origin.readingRef,
    signal,
    refresh ? { refresh: true } : undefined,
  );
  if (receipt.status !== 'settled') return receipt.status;
  return receipt.exact ? ('settled' as const) : ('unavailable' as const);
}

export function startFromForeground(response: MessageSearchResponse, port: ChatReadingPort | null, threadId: string) {
  if (!port || port.threadId !== threadId) return null;
  const origin = port.captureReadingRef();
  if (!origin) return null;
  const trip = beginMessageReadingTrip(response, { threadId, readingRef: origin.ref });
  return trip ? startMessageReadingSession(trip, origin.persisted) : null;
}

export function startJumpTargetFromForeground(messageId: string, port: ChatReadingPort | null, threadId: string) {
  if (!messageId || !port || port.threadId !== threadId) return null;
  const origin = port.captureReadingRef();
  if (!origin) return null;
  const started = startMessageReadingSession(
    {
      searchId: `jump:${crypto.randomUUID()}`,
      origin: { threadId, readingRef: origin.ref },
      targets: [{ threadId, messageId }],
      generation: 0,
      settledIndex: null,
      pending: null,
      status: 'ready',
    },
    origin.persisted,
    undefined,
    'jump',
  );
  const requested = requestMessageReadingTarget(started.session.trip, 0);
  return requested
    ? { session: { ...started.session, trip: requested.trip }, effect: requested.effect, persisted: started.persisted }
    : null;
}

export function toInitialFindState(response: MessageSearchResponse): MessageFindState {
  return {
    query: response.query,
    scope: response.meta.scope,
    sort: response.meta.sort === 'selected' ? 'time' : response.meta.sort,
    scrollTop: 0,
    status: 'ready',
    response,
  };
}

export function startFindPageFromForeground(find: MessageFindContext, port: ChatReadingPort | null, threadId: string) {
  if (!port || port.threadId !== threadId) return null;
  const origin = port.captureReadingRef();
  if (!origin) return null;
  if (!origin.persisted) {
    port.releaseReadingRef(origin.ref);
    return null;
  }
  const started = startMessageReadingSession(
    {
      searchId: find.state.response?.searchId ?? crypto.randomUUID(),
      origin: { threadId, readingRef: origin.ref },
      targets: [],
      generation: 0,
      settledIndex: null,
      pending: null,
      status: 'ready',
    },
    origin.persisted,
    find,
  );
  if (started.persisted && origin.persisted) return started;
  port.releaseReadingRef(origin.ref);
  return null;
}

export function prepareOpenDestination(
  destination: MessageFindDestination,
  state: MessageFindState,
  workspaceOrigin: MessageFindContext['workspaceOrigin'],
  port: ChatReadingPort | null,
  threadId: string,
) {
  const find = parseMessageFindContext({ destination, state, ...(workspaceOrigin ? { workspaceOrigin } : {}) });
  if (!find) return null;
  const started = startFindPageFromForeground(find, port, threadId);
  return started
    ? { ok: true as const, ...started }
    : { ok: false as const, notice: '当前阅读位置或查找状态暂无法保存，请留在对话中再试。' };
}

export function prepareNavigateResult(
  result: MessageSearchResult,
  response: MessageSearchResponse,
  active: MessageReadingSession | null,
  port: ChatReadingPort | null,
  threadId: string,
):
  | { ok: false; notice: string | null }
  | {
      ok: true;
      session: MessageReadingSession;
      effect: MessageReadingEffect;
      startedPersisted?: boolean;
    } {
  const index = response.results.findIndex(
    (candidate) => candidate.threadId === result.threadId && candidate.messageId === result.messageId,
  );
  if (index < 0) return { ok: false, notice: '这条来源不属于当前检索结果，暂不可跳转。' };
  let base = active;
  let startedPersisted: boolean | undefined;
  if (!base || base.trip.searchId !== response.searchId || base.trip.status === 'completed') {
    const started = startFromForeground(response, port, threadId);
    if (!started) return { ok: false, notice: '当前阅读位置暂不可保存，请在对话中重新尝试。' };
    base = started.session;
    startedPersisted = started.persisted;
  }
  const indexInCollection = base.trip.targets.findIndex(
    (target) => target.threadId === result.threadId && target.messageId === result.messageId,
  );
  const requested = requestMessageReadingTarget(base.trip, indexInCollection);
  if (!requested) return { ok: false, notice: null };
  return {
    ok: true,
    session: { ...base, trip: requested.trip },
    effect: requested.effect,
    ...(startedPersisted !== undefined ? { startedPersisted } : {}),
  };
}
