'use client';

import {
  type ChatBackgroundState as ChatBackground,
  type ChatBackgroundStatePreferences as ChatBackgroundPreferences,
  decodeChatBackgroundPreferences,
  serializeChatBackgroundState,
} from '@cat-cafe/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type Change = { scope: 'global' | 'thread'; threadId?: string; background: ChatBackground | null };
const EMPTY: ChatBackgroundPreferences = { threads: {} };
const BackgroundContext = createContext<{
  enabled: boolean;
  preferences: ChatBackgroundPreferences;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  reload(): Promise<void>;
  save(change: Change): Promise<boolean>;
} | null>(null);

async function readResponse(response: Response): Promise<ChatBackgroundPreferences> {
  if (!response.ok) throw new Error(`Background request failed (${response.status})`);
  return decodeChatBackgroundPreferences(await response.json());
}

function applyChange(current: ChatBackgroundPreferences, change: Change): ChatBackgroundPreferences {
  if (change.scope === 'global') {
    const next = { ...current };
    if (change.background) next.global = change.background;
    else delete next.global;
    return next;
  }
  if (!change.threadId) return current;
  const threads = { ...current.threads };
  if (change.background) return { ...current, threads: { ...threads, [change.threadId]: change.background } };
  delete threads[change.threadId];
  return { ...current, threads };
}

/** One owner-private preference stream for the shell and both editors. No chat-store writes. */
export function ChatBackgroundProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [preferences, setPreferences] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(0);
  const confirmed = useRef(EMPTY);
  const mutation = useRef(0);
  const pendingMutations = useRef(0);
  const queued = useRef(Promise.resolve());
  const generation = useRef(0);
  const active = useRef(enabled);
  active.current = enabled;

  const reload = useCallback(async () => {
    if (!active.current) return;
    const ticket = ++generation.current;
    const atMutation = mutation.current;
    const beganDuringSave = pendingMutations.current > 0;
    const currentLoad = () =>
      active.current &&
      !beganDuringSave &&
      pendingMutations.current === 0 &&
      ticket === generation.current &&
      atMutation === mutation.current;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await readResponse(await apiFetch('/api/config/chat-background'));
      if (!currentLoad()) return;
      confirmed.current = next;
      setPreferences(next);
    } catch {
      if (currentLoad()) setLoadError(true);
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
    else {
      setLoading(false);
      setLoadError(false);
    }
    return () => {
      generation.current += 1;
    };
  }, [enabled, reload]);

  const save = useCallback(
    async (change: Change): Promise<boolean> => {
      if (!active.current || loading || loadError) return false;
      const id = ++mutation.current;
      pendingMutations.current += 1;
      setPreferences((current) => applyChange(current, change));
      setPending((count) => count + 1);
      let succeeded = false;
      const job = queued.current.then(async () => {
        try {
          const next = await readResponse(
            await apiFetch('/api/config/chat-background', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...change, ...serializeChatBackgroundState(change.background) }),
            }),
          );
          confirmed.current = next;
          if (id === mutation.current) setPreferences(next);
          succeeded = true;
        } catch {
          if (id === mutation.current) setPreferences(confirmed.current);
        } finally {
          pendingMutations.current -= 1;
          setPending((count) => count - 1);
        }
      });
      queued.current = job;
      await job;
      return succeeded;
    },
    [loading, loadError],
  );

  return (
    <BackgroundContext.Provider value={{ enabled, preferences, loading, loadError, saving: pending > 0, reload, save }}>
      {children}
    </BackgroundContext.Provider>
  );
}

export function useChatBackgroundPreferences() {
  return useContext(BackgroundContext);
}
