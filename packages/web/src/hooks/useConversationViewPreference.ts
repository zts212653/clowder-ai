'use client';

import {
  type ConversationViewPreference,
  type ConversationViewPreferenceSnapshot,
  conversationViewPreferenceSnapshotSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const PRODUCT_SNAPSHOT: ConversationViewPreferenceSnapshot = {
  stored: null,
  effective: { mode: 'group' },
  source: 'product',
};

function parseSnapshot(value: unknown): ConversationViewPreferenceSnapshot | null {
  const parsed = conversationViewPreferenceSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sameView(left: ConversationViewPreference | null, right: ConversationViewPreference): boolean {
  if (!left || left.mode !== right.mode) return false;
  return left.mode === 'group' || (right.mode === 'cat' && left.catId === right.catId);
}

async function persistConversationView(
  threadId: string,
  view: ConversationViewPreference,
): Promise<ConversationViewPreferenceSnapshot> {
  const response = await apiFetch('/api/config/conversation-view', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, view }),
  });
  if (!response.ok) throw new Error(`conversation view save failed (${response.status})`);
  const parsed = parseSnapshot(await response.json());
  if (!parsed) throw new Error('conversation view response is invalid');
  return parsed;
}

export type ConversationViewPreferenceError = 'load' | 'save' | null;
export type ConversationViewPreferenceBeforeCommit = (
  previous: ConversationViewPreferenceSnapshot,
  next: ConversationViewPreferenceSnapshot,
) => void;

export interface ConversationViewPreferenceController {
  snapshot: ConversationViewPreferenceSnapshot;
  loading: boolean;
  saving: boolean;
  error: ConversationViewPreferenceError;
  save(view: ConversationViewPreference): Promise<boolean>;
  subscribeBeforeCommit(listener: ConversationViewPreferenceBeforeCommit): () => void;
}

export function useConversationViewPreference(threadId: string, enabled = true): ConversationViewPreferenceController {
  const [snapshot, setSnapshot] = useState<ConversationViewPreferenceSnapshot>(PRODUCT_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ConversationViewPreferenceError>(null);
  const generationRef = useRef(0);
  const snapshotRef = useRef(PRODUCT_SNAPSHOT);
  const beforeCommitListenersRef = useRef(new Set<ConversationViewPreferenceBeforeCommit>());
  const commitSnapshot = useCallback((next: ConversationViewPreferenceSnapshot) => {
    const previous = snapshotRef.current;
    for (const listener of beforeCommitListenersRef.current) {
      try {
        listener(previous, next);
      } catch (cause) {
        console.error('Conversation view before-commit subscriber failed', cause);
      }
    }
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const subscribeBeforeCommit = useCallback((listener: ConversationViewPreferenceBeforeCommit) => {
    beforeCommitListenersRef.current.add(listener);
    return () => beforeCommitListenersRef.current.delete(listener);
  }, []);

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      snapshotRef.current = PRODUCT_SNAPSHOT;
      setSnapshot(PRODUCT_SNAPSHOT);
      setLoading(false);
      setSaving(false);
      setError(null);
      return;
    }
    let activeRead: AbortController | undefined;
    const load = () => {
      activeRead?.abort();
      const generation = ++generationRef.current;
      const abort = new AbortController();
      activeRead = abort;
      snapshotRef.current = PRODUCT_SNAPSHOT;
      setSnapshot(PRODUCT_SNAPSHOT);
      setLoading(true);
      setSaving(false);
      setError(null);
      void apiFetch(`/api/config/conversation-view?threadId=${encodeURIComponent(threadId)}`, { signal: abort.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`conversation view load failed (${response.status})`);
          const parsed = parseSnapshot(await response.json());
          if (!parsed) throw new Error('conversation view response is invalid');
          if (generation === generationRef.current) commitSnapshot(parsed);
        })
        .catch((cause: unknown) => {
          if (abort.signal.aborted || generation !== generationRef.current) return;
          console.error('Failed to load conversation view preference', cause);
          setError('load');
        })
        .finally(() => {
          if (generation === generationRef.current) setLoading(false);
        });
    };
    const leaveDocument = () => {
      activeRead?.abort();
      generationRef.current += 1;
    };
    const returnToDocument = (event: PageTransitionEvent) => {
      if (event.persisted) load();
    };
    // Full document navigation does not run React's unmount cleanup. End its
    // pending read explicitly, and reconcile again if BFCache restores it.
    window.addEventListener('pagehide', leaveDocument);
    window.addEventListener('pageshow', returnToDocument);
    load();
    return () => {
      window.removeEventListener('pagehide', leaveDocument);
      window.removeEventListener('pageshow', returnToDocument);
      leaveDocument();
    };
  }, [commitSnapshot, enabled, threadId]);

  const save = useCallback(
    async (view: ConversationViewPreference): Promise<boolean> => {
      if (!enabled || loading || saving) return false;
      if (sameView(snapshot.stored, view)) {
        setError(null);
        return true;
      }
      const generation = generationRef.current;
      setSaving(true);
      setError(null);
      try {
        const parsed = await persistConversationView(threadId, view);
        if (generation !== generationRef.current) return false;
        commitSnapshot(parsed);
        return true;
      } catch (cause) {
        if (generation !== generationRef.current) return false;
        console.error('Failed to save conversation view preference', cause);
        setError('save');
        return false;
      } finally {
        if (generation === generationRef.current) setSaving(false);
      }
    },
    [commitSnapshot, enabled, loading, saving, snapshot.stored, threadId],
  );

  return { snapshot, loading, saving, error, save, subscribeBeforeCommit };
}
