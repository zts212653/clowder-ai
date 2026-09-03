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

  useEffect(() => {
    setSelectedMessageIds((current) => {
      const selectableIds = new Set(messages.filter(isMessageSelectableForBundle).map((message) => message.id));
      const next = new Set([...current].filter((messageId) => selectableIds.has(messageId)));
      if (next.size === current.size && [...next].every((messageId) => current.has(messageId))) return current;
      return next;
    });
  }, [messages]);

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
