'use client';

import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { flushComposerDraft } from '@/components/composer-draft-flush-registry';
import { useShellCopy } from '@/components/shell/shell-copy';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { ComposerDraftInsert } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { scheduleCopy } from './product-schedule.shell-copy';

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function originalViewStillCurrent(threadId: string, route: string): boolean {
  const state = useChatStore.getState();
  return (
    state.currentThreadId === threadId &&
    !state.presentationLock &&
    !state.pendingChatInsert &&
    window.location.pathname + window.location.search === route
  );
}

function assertProgressSourceCurrent(
  read: EntrustedWorkOwnerReadV1,
  latestRead: EntrustedWorkOwnerReadV1,
  threadId: string,
  route: string,
  signal: AbortSignal,
): void {
  if (signal.aborted || read !== latestRead || !originalViewStillCurrent(threadId, route)) {
    throw new Error('Original conversation or composer changed');
  }
}

async function readOriginalConversation(threadId: string, ownerUserId: string, signal: AbortSignal): Promise<void> {
  const [session, response] = await Promise.all([
    apiFetch('/api/session', { signal }),
    apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, { signal }),
  ]);
  if (!session.ok || !response.ok) throw new Error('Original conversation unavailable');
  const [principal, thread]: unknown[] = await Promise.all([session.json(), response.json()]);
  if (
    field(principal, 'userId') !== ownerUserId ||
    field(thread, 'id') !== threadId ||
    field(thread, 'createdBy') !== ownerUserId
  )
    throw new Error('Original source changed');
}

function openUnsentProgressQuestion(insert: ComposerDraftInsert): void {
  useChatStore.getState().setPendingChatInsert(insert);
  try {
    pushThreadRouteWithHistory(insert.threadId, window);
  } catch (error) {
    if (useChatStore.getState().pendingChatInsert === insert) useChatStore.getState().setPendingChatInsert(null);
    throw error;
  }
}

/** Navigate through the original Chat port; the original owner composer saves the unsent question. */
export function ScheduleAskProgress({ ownerRead }: { ownerRead: EntrustedWorkOwnerReadV1 }) {
  const t = useShellCopy(scheduleCopy);
  const [reading, setReading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const currentRead = useRef(ownerRead);
  currentRead.current = ownerRead;
  useEffect(() => () => request.current?.abort(), []);
  const work = ownerRead.work;
  const available = Boolean(
    work &&
      /^[A-Za-z0-9_-]{1,160}$/.test(work.threadId) &&
      ownerRead.envelope.visibility.human &&
      ownerRead.envelope.freshness.state === 'current' &&
      !ownerRead.completion,
  );
  const unavailable = () =>
    useToastStore.getState().addToast({
      type: 'info',
      title: t.askProgress,
      message: t.questionUnavailable,
      duration: 6000,
    });

  const ask = async () => {
    const initial = useChatStore.getState();
    if (request.current || !available || !work) return;
    if (initial.presentationLock || initial.pendingChatInsert) {
      unavailable();
      return;
    }
    const sourceThread = initial.currentThreadId;
    const sourceRoute = window.location.pathname + window.location.search;
    const controller = new AbortController();
    request.current = controller;
    setReading(true);
    try {
      await readOriginalConversation(work.threadId, ownerRead.envelope.visibility.ownerUserId, controller.signal);
      assertProgressSourceCurrent(ownerRead, currentRead.current, sourceThread, sourceRoute, controller.signal);
      await flushComposerDraft(sourceThread);
      assertProgressSourceCurrent(ownerRead, currentRead.current, sourceThread, sourceRoute, controller.signal);
      const insert = {
        threadId: work.threadId,
        text: t.progressQuestion(work.title),
        waitForDraft: true,
        preserveSelection: true,
        draftReadFailure: { title: t.askProgress, message: t.questionDraftUnavailable },
      };
      openUnsentProgressQuestion(insert);
    } catch {
      if (!controller.signal.aborted) unavailable();
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setReading(false);
    }
  };
  return (
    <button
      type="button"
      data-testid="schedule-ask-progress"
      disabled={!available || reading}
      title={available ? t.questionHint : t.questionUnavailable}
      onClick={() => void ask()}
      className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-50"
    >
      {reading ? t.questionReading : t.askProgress}
    </button>
  );
}
