'use client';

import type { MessageBundleSelectionItem } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import {
  isWholeMessageSelected,
  type MessagePartSelection,
  partialSelectionSummary,
  selectedMessageParts,
  wholeMessageSelection,
} from '../message-part-selection';
import { isMessageSelectableForBundle, MAX_SELECTED_MESSAGES, normalizeSelectedMessageIds } from '../message-selection';

export function useThreadChatSelection(messages: readonly ChatMessage[]) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [partSelections, setPartSelections] = useState<Map<string, MessagePartSelection>>(() => new Map());
  const [selectionForwardOpen, setSelectionForwardOpen] = useState(false);
  const [selectedBundleItems, setSelectedBundleItems] = useState<MessageBundleSelectionItem[]>([]);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectedMessageIds = useMemo(() => new Set(partSelections.keys()), [partSelections]);
  const normalizedSelectedMessageIds = useMemo(
    () => normalizeSelectedMessageIds(messages, selectedMessageIds),
    [messages, selectedMessageIds],
  );
  const summary = useMemo(() => partialSelectionSummary(messages, partSelections), [messages, partSelections]);
  const getSelectedBundleItems = useCallback(
    () => selectedMessageParts(messages, partSelections),
    [messages, partSelections],
  );
  const clearMessageSelection = useCallback(() => {
    setSelectionForwardOpen(false);
    setSelectionMode(false);
    setPartSelections(new Map());
    setSelectionError(null);
    setSelectedBundleItems([]);
  }, []);
  const enterMessageSelection = useCallback(
    (messageId: string) => {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message || !isMessageSelectableForBundle(message)) return;
      setPartSelections(new Map([[messageId, wholeMessageSelection(message)]]));
      setSelectionError(null);
      setSelectionMode(true);
    },
    [messages],
  );
  const toggleMessageSelection = useCallback(
    (messageId: string) => {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message || !isMessageSelectableForBundle(message)) return;
      setSelectionError(null);
      setPartSelections((current) => {
        const next = new Map(current);
        if (isWholeMessageSelected(message, current.get(messageId))) next.delete(messageId);
        else if (next.has(messageId) || next.size < MAX_SELECTED_MESSAGES)
          next.set(messageId, wholeMessageSelection(message));
        return next;
      });
    },
    [messages],
  );
  const toggleRichBlockSelection = useCallback(
    (messageId: string, blockId: string) => {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (
        !message ||
        !isMessageSelectableForBundle(message) ||
        !message.extra?.rich?.blocks.some((block) => block.id === blockId)
      )
        return;
      setSelectionError(null);
      setPartSelections((current) => {
        if (!current.has(messageId) && current.size >= MAX_SELECTED_MESSAGES) return current;
        const previous = current.get(messageId);
        const blockIds = new Set(previous?.blockIds);
        if (blockIds.has(blockId)) blockIds.delete(blockId);
        else blockIds.add(blockId);
        const next = new Map(current);
        if (!previous?.includeText && blockIds.size === 0) next.delete(messageId);
        else next.set(messageId, { includeText: previous?.includeText ?? false, blockIds });
        return next;
      });
    },
    [messages],
  );
  // Decide before scheduling updates: streaming siblings must not cause a no-op setState chain.
  useEffect(() => {
    const selectable = new Set(messages.filter(isMessageSelectableForBundle).map((message) => message.id));
    if ([...partSelections.keys()].every((id) => selectable.has(id))) return;
    setPartSelections((current) => new Map([...current].filter(([id]) => selectable.has(id))));
  }, [messages, partSelections]);
  const openSelectionForward = useCallback(() => {
    try {
      const items = getSelectedBundleItems();
      if (!items.length) return;
      setSelectedBundleItems(items);
      setSelectionError(null);
      setSelectionForwardOpen(true);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '所选内容无法转发');
    }
  }, [getSelectedBundleItems]);
  return {
    selectionMode,
    selectedMessageIds,
    partSelections,
    selectionForwardOpen,
    normalizedSelectedMessageIds,
    selectedBundleItems,
    selectionError,
    ...summary,
    getSelectedBundleItems,
    clearMessageSelection,
    enterMessageSelection,
    toggleMessageSelection,
    toggleRichBlockSelection,
    openSelectionForward,
    isPartiallySelected: (id: string) => {
      const message = messages.find((candidate) => candidate.id === id);
      return Boolean(message && partSelections.has(id) && !isWholeMessageSelected(message, partSelections.get(id)));
    },
    closeSelectionForward: () => setSelectionForwardOpen(false),
  };
}
