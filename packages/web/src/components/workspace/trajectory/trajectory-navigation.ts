'use client';

import type { TrajectoryOriginRef } from '@cat-cafe/shared';
import { CHAT_THREAD_ROUTE_EVENT, getThreadHref } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { restoreMessageScrollAnchor } from '@/utils/scrollToMessage';

export const TRAJECTORY_OPEN_EVENT = 'cat-cafe:open-invocation-trajectory';

export interface TrajectoryTarget {
  invocationId: string;
  threadId?: string;
  sessionId?: string;
  originRef?: TrajectoryOriginRef;
}

function isFiniteOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function encodeTrajectoryOriginRef(originRef: TrajectoryOriginRef): string {
  const { kind, ...payload } = originRef;
  return `${kind}:${JSON.stringify(payload)}`;
}

export function decodeTrajectoryOriginRef(value: string | null | undefined): TrajectoryOriginRef | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(':');
  if (separator < 1) return undefined;
  const kind = value.slice(0, separator);
  try {
    const payload = JSON.parse(value.slice(separator + 1)) as Record<string, unknown>;
    if (
      kind === 'message' &&
      typeof payload.threadId === 'string' &&
      typeof payload.messageId === 'string' &&
      isFiniteOffset(payload.viewportOffsetPx)
    ) {
      return {
        kind,
        threadId: payload.threadId,
        messageId: payload.messageId,
        viewportOffsetPx: payload.viewportOffsetPx,
      };
    }
    if (
      kind === 'eval' &&
      typeof payload.threadId === 'string' &&
      typeof payload.eventId === 'string' &&
      isFiniteOffset(payload.viewportOffsetPx)
    ) {
      return {
        kind,
        threadId: payload.threadId,
        eventId: payload.eventId,
        viewportOffsetPx: payload.viewportOffsetPx,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function readTrajectoryTarget(url: URL): TrajectoryTarget | undefined {
  const invocationId = url.searchParams.get('inv')?.trim();
  if (!invocationId) return undefined;
  const threadId = url.searchParams.get('trajectoryThread')?.trim();
  const sessionId = url.searchParams.get('session')?.trim();
  const originRef = decodeTrajectoryOriginRef(url.searchParams.get('origin'));
  return {
    invocationId,
    ...(threadId ? { threadId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(originRef ? { originRef } : {}),
  };
}

export function hydrateInvocationTrajectoryFromCurrentUrl(): TrajectoryTarget | undefined {
  if (typeof window === 'undefined') return undefined;
  const target = readTrajectoryTarget(new URL(window.location.href));
  if (!target) return undefined;
  const store = useChatStore.getState();
  store.setWorkspaceMode('trajectory');
  store.setRightPanelOpen(true);
  return target;
}

function writeTargetToHistory(target: TrajectoryTarget, historyMode: 'push' | 'replace'): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('workspaceMode', 'trajectory');
  if (target.threadId) url.searchParams.set('trajectoryThread', target.threadId);
  else url.searchParams.delete('trajectoryThread');
  url.searchParams.set('inv', target.invocationId);
  if (target.sessionId) url.searchParams.set('session', target.sessionId);
  else url.searchParams.delete('session');
  if (target.originRef) url.searchParams.set('origin', encodeTrajectoryOriginRef(target.originRef));
  else url.searchParams.delete('origin');
  const state = { ...(window.history.state ?? {}), invocationTrajectory: target.invocationId };
  if (historyMode === 'replace') window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}

export function replaceInvocationTrajectoryTarget(target: TrajectoryTarget): void {
  writeTargetToHistory(target, 'replace');
}

export function replaceInvocationTrajectoryThreadRoute(threadId: string): void {
  if (typeof window === 'undefined') return;
  const pathname = getThreadHref(threadId);
  if (window.location.pathname === pathname) return;
  const url = new URL(window.location.href);
  url.pathname = pathname;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
}

export function openInvocationTrajectory(target: TrajectoryTarget, historyMode: 'push' | 'replace' = 'push'): void {
  const store = useChatStore.getState();
  store.setWorkspaceMode('trajectory');
  store.setRightPanelOpen(true);
  writeTargetToHistory(target, historyMode);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<TrajectoryTarget>(TRAJECTORY_OPEN_EVENT, { detail: target }));
  }
}

export function clearInvocationTrajectoryUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete('trajectoryThread');
  url.searchParams.delete('inv');
  url.searchParams.delete('session');
  url.searchParams.delete('origin');
  window.history.replaceState({ ...(window.history.state ?? {}), invocationTrajectory: undefined }, '', url);
}

function retryOnAnimationFrame(action: () => boolean, attempts = 12): void {
  if (attempts <= 0 || typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    if (!action()) retryOnAnimationFrame(action, attempts - 1);
  });
}

export function findEvalWorkspaceEvent(eventId: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-eval-event-id]')).find(
    (element) => element.dataset.evalEventId === eventId,
  );
}

export function findTrajectoryOriginScrollContainer(element?: HTMLElement): HTMLElement | undefined {
  return (
    element?.closest<HTMLElement>('[data-trajectory-origin-scroll]') ??
    document.querySelector<HTMLElement>('[data-eval-workspace-scroll]') ??
    undefined
  );
}

export function restoreTrajectoryOrigin(originRef: TrajectoryOriginRef): void {
  clearInvocationTrajectoryUrl();
  const store = useChatStore.getState();
  if (store.currentThreadId !== originRef.threadId) store.setCurrentThread(originRef.threadId);
  replaceInvocationTrajectoryThreadRoute(originRef.threadId);
  if (originRef.kind === 'message') {
    store.setRightPanelOpen(false);
    retryOnAnimationFrame(() => {
      const container = document.querySelector<HTMLElement>('[data-chat-container]');
      return container
        ? restoreMessageScrollAnchor(container, {
            messageId: originRef.messageId,
            viewportOffsetPx: originRef.viewportOffsetPx,
          })
        : false;
    });
    return;
  }

  store.setWorkspaceMode('eval');
  const restoreEvalOrigin = () => {
    const element = findEvalWorkspaceEvent(originRef.eventId);
    const container = findTrajectoryOriginScrollContainer(element);
    if (!element || !container) return false;
    if (document.activeElement !== element) {
      const currentOffset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop = Math.max(0, container.scrollTop + currentOffset - originRef.viewportOffsetPx);
      element.focus({ preventScroll: true });
    }
    return document.activeElement === element;
  };
  restoreEvalOrigin();
  retryOnAnimationFrame(restoreEvalOrigin);
}

export function restoreTrajectoryPromptMessage(threadId: string, messageId: string): void {
  restoreTrajectoryOrigin({ kind: 'message', threadId, messageId, viewportOffsetPx: 0 });
}
