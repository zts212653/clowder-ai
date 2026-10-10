'use client';

import type { MessageBundleSelectionItem } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { isMessageSelectableForBundle, MAX_SELECTED_MESSAGES, normalizeSelectedMessageIds } from '../message-selection';

export function useThreadChatSelection(messages: readonly ChatMessage[]) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [selectionForwardOpen, setSelectionForwardOpen] = useState(false);

  const normalizedSelectedMessageIds = useMemo(
    () => normalizeSelectedMessageIds(messages, selectedMessageIds),
    [messages, selectedMessageIds],
  );
  const selectedBundleItems = useMemo<MessageBundleSelectionItem[]>(
    () => normalizedSelectedMessageIds.map((messageId) => ({ kind: 'message', messageId })),
    [normalizedSelectedMessageIds],
  );

  const clearMessageSelection = useCallback(() => {
    setSelectionForwardOpen(false);
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const enterMessageSelection = useCallback(
    (messageId: string) => {
      const candidate = messages.find((message) => message.id === messageId);
      if (!candidate || !isMessageSelectableForBundle(candidate)) return;
      setSelectedMessageIds(new Set([messageId]));
      setSelectionMode(true);
    },
    [messages],
  );

  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else if (next.size < MAX_SELECTED_MESSAGES) {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  // Drop selected ids whose messages went away or stopped being selectable. Decide before calling setState: while a
  // reply streams, `messages` changes on nearly every commit and this component usually has work pending, so React
  // cannot skip an updater that returns the same Set; each call would be a real update scheduled from the commit
  // phase, and a long chain of them trips React's nested-update limit (F117 baseline B).
  useEffect(() => {
    if (selectedMessageIds.size === 0) return;
    const selectableIds = new Set(messages.filter(isMessageSelectableForBundle).map((message) => message.id));
    if ([...selectedMessageIds].every((messageId) => selectableIds.has(messageId))) return;
    setSelectedMessageIds((current) => new Set([...current].filter((messageId) => selectableIds.has(messageId))));
  }, [messages, selectedMessageIds]);

  return {
    selectionMode,
    selectedMessageIds,
    selectionForwardOpen,
    normalizedSelectedMessageIds,
    selectedBundleItems,
    clearMessageSelection,
    enterMessageSelection,
    toggleMessageSelection,
    openSelectionForward: () => setSelectionForwardOpen(true),
    closeSelectionForward: () => setSelectionForwardOpen(false),
  };
}
