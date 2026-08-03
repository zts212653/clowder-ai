'use client';

import { type Dispatch, type SetStateAction, useCallback, useState, useSyncExternalStore } from 'react';
import type { ChatMessage } from '@/stores/chat-types';

export type MessageDisclosurePanel = 'body' | 'thinking' | 'cli';

const MAX_DISCLOSURE_OVERRIDES = 500;
const disclosureOverrides = new Map<string, boolean>();
const disclosureListeners = new Map<string, Set<() => void>>();

function emitDisclosureChange(key: string): void {
  for (const listener of disclosureListeners.get(key) ?? []) {
    listener();
  }
}

function subscribeToDisclosure(key: string | undefined, listener: () => void): () => void {
  if (!key) return () => {};
  const listeners = disclosureListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  disclosureListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disclosureListeners.delete(key);
  };
}

function setDisclosureOverride(key: string, expanded: boolean): void {
  disclosureOverrides.delete(key);
  disclosureOverrides.set(key, expanded);
  emitDisclosureChange(key);

  if (disclosureOverrides.size <= MAX_DISCLOSURE_OVERRIDES) return;
  const oldestKey = disclosureOverrides.keys().next().value;
  if (typeof oldestKey !== 'string') return;
  disclosureOverrides.delete(oldestKey);
  emitDisclosureChange(oldestKey);
}

export function buildMessageDisclosureKey(
  threadId: string,
  message: Pick<ChatMessage, 'id' | 'type' | 'catId' | 'extra'>,
  panel: MessageDisclosurePanel,
): string {
  const stableBubbleId = message.extra?.isExplicitPost
    ? message.id
    : (message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId ?? message.id);
  const owner = message.catId ?? message.type;
  return [threadId, owner, stableBubbleId, panel].map(encodeURIComponent).join(':');
}

export function useMessageDisclosureState(
  disclosureKey: string | undefined,
  defaultExpanded: boolean,
): {
  expanded: boolean;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  hasOverride: boolean;
} {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const subscribe = useCallback(
    (listener: () => void) => subscribeToDisclosure(disclosureKey, listener),
    [disclosureKey],
  );
  const getSnapshot = useCallback(
    () => (disclosureKey ? disclosureOverrides.get(disclosureKey) : undefined),
    [disclosureKey],
  );
  const override = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  const setExpanded = useCallback<Dispatch<SetStateAction<boolean>>>(
    (next) => {
      if (!disclosureKey) {
        setLocalExpanded(next);
        return;
      }
      const current = disclosureOverrides.get(disclosureKey) ?? defaultExpanded;
      const expanded = typeof next === 'function' ? next(current) : next;
      setDisclosureOverride(disclosureKey, expanded);
    },
    [defaultExpanded, disclosureKey],
  );

  return {
    expanded: disclosureKey ? (override ?? defaultExpanded) : localExpanded,
    setExpanded,
    hasOverride: override !== undefined,
  };
}

export function resetMessageDisclosureStateForTest(): void {
  const keys = [...disclosureOverrides.keys()];
  disclosureOverrides.clear();
  for (const key of keys) emitDisclosureChange(key);
}
