'use client';

import type { ConversationViewPreference } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import {
  type ConversationViewPreferenceController,
  useConversationViewPreference,
} from '@/hooks/useConversationViewPreference';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { projectSingleCatConversation } from '../thread-chat/single-cat-conversation-projection';
import { ConversationViewOptions, ConversationViewTrigger } from './ConversationViewMenuContent';
import { conversationViewCopy } from './conversation-view.shell-copy';
import { knownCatName, UNKNOWN_CAT_NAME } from './ShellCatAvatar';
import { useShellCopy } from './shell-copy';

const EMPTY_MESSAGES: readonly ChatMessage[] = [];
const EMPTY_QUEUE: readonly QueueEntry[] = [];

export interface ConversationViewMenuProps {
  threadId: string;
  controller?: ConversationViewPreferenceController;
  messages?: readonly ChatMessage[];
  queue?: readonly QueueEntry[];
}

export function ConversationViewMenu({
  threadId,
  controller,
  messages = EMPTY_MESSAGES,
  queue = EMPTY_QUEUE,
}: ConversationViewMenuProps) {
  const participants =
    useSidebarProjectionStore((state) => state.rows.find((row) => row.id === threadId)?.participants) ?? [];
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const runningCatIds = useMemo(
    () =>
      new Set(
        Object.values(executionsByKey)
          .filter((execution) => execution.threadId === threadId)
          .map((execution) => execution.catId),
      ),
    [executionsByKey, threadId],
  );
  if (participants.length === 0) return null;
  return (
    <ReadyConversationViewMenu
      threadId={threadId}
      participants={participants}
      runningCatIds={runningCatIds}
      providedController={controller}
      messages={messages}
      queue={queue}
    />
  );
}

function useConversationMenuState() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  return { open, setOpen, rootRef, triggerRef };
}

function resolveVisibleView(
  controller: ConversationViewPreferenceController,
  availableCatIds: ReadonlySet<string>,
): ConversationViewPreference {
  if (controller.loading) return { mode: 'group' };
  const requested = controller.snapshot.effective;
  if (requested.mode === 'cat' && availableCatIds.has(requested.catId)) return requested;
  return { mode: 'group' };
}

function ReadyConversationViewMenu({
  threadId,
  participants,
  runningCatIds,
  providedController,
  messages,
  queue,
}: {
  threadId: string;
  participants: readonly string[];
  runningCatIds: ReadonlySet<string>;
  providedController?: ConversationViewPreferenceController;
  messages: readonly ChatMessage[];
  queue: readonly QueueEntry[];
}) {
  const fallbackController = useConversationViewPreference(threadId, providedController === undefined);
  const controller = providedController ?? fallbackController;
  const { getCatById } = useCatData();
  const words = useShellCopy(conversationViewCopy);
  const menu = useConversationMenuState();
  const availableCatIds = useMemo(
    () => new Set(participants.filter((catId) => projectSingleCatConversation({ messages, queue, catId }).hasEvidence)),
    [messages, participants, queue],
  );
  const visibleView = resolveVisibleView(controller, availableCatIds);
  const resolveName = (catId: string) => knownCatName(catId, getCatById) ?? UNKNOWN_CAT_NAME;
  const visibleName = visibleView.mode === 'cat' ? resolveName(visibleView.catId) : words.group;
  const select = async (view: ConversationViewPreference) => {
    if (await controller.save(view)) menu.setOpen(false);
  };

  return (
    <div ref={menu.rootRef} className="relative flex-none" data-testid="conversation-view-control">
      <ConversationViewTrigger
        triggerRef={menu.triggerRef}
        open={menu.open}
        onToggle={() => menu.setOpen((current) => !current)}
        visibleView={visibleView}
        visibleName={visibleName}
        participants={participants}
        runningCatIds={runningCatIds}
        words={words}
      />
      {menu.open ? (
        <ConversationViewOptions
          participants={participants}
          runningCatIds={runningCatIds}
          availableCatIds={availableCatIds}
          visibleView={visibleView}
          controller={controller}
          resolveName={resolveName}
          select={select}
          words={words}
        />
      ) : null}
    </div>
  );
}
