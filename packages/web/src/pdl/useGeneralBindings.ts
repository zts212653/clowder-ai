'use client';
import type { MessageDispositionPreferenceSnapshot } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from './owner-api';

export function useGeneralBindings(
  threadId: string,
  ui: import('./types').ChatUiState,
  needed: (source: string) => boolean | number = () => false,
) {
  const snapshot = useRef<MessageDispositionPreferenceSnapshot | null>(null);
  const error = useRef<unknown>(null);
  const viewError = useRef<unknown>(null);
  const [view, setView] = useState<{
    threadId: string;
    value: import('@cat-cafe/shared').ConversationViewPreferenceSnapshot;
  } | null>(null);
  const [, changed] = useState(0);
  const snapshotNeeded = needed('snapshot'),
    viewNeeded = needed('view');
  useEffect(() => {
    if (!snapshotNeeded) return;
    let active = true;
    void request<MessageDispositionPreferenceSnapshot>('/api/config/message-disposition').then(
      (value) => {
        if (active) {
          snapshot.current = value;
          changed((n) => n + 1);
        }
      },
      (cause) => {
        if (active) {
          error.current = cause;
          changed((n) => n + 1);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [snapshotNeeded]);
  useEffect(() => {
    ui.viewCat = null;
    viewError.current = null;
    if (!viewNeeded || threadId === 'default') return;
    let active = true;
    void request<import('@cat-cafe/shared').ConversationViewPreferenceSnapshot>(
      '/api/config/conversation-view?' + new URLSearchParams({ threadId }),
    ).then(
      (result) => {
        if (active) {
          viewError.current = null;
          setView({ threadId, value: result });
          changed((n) => n + 1);
        }
      },
      (cause) => {
        if (active) {
          viewError.current = cause;
          setView(null);
          changed((n) => n + 1);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [viewNeeded, threadId]);
  const rawData = useMemo(
    () => ({ snapshot: snapshot.current, error: error.current, viewError: viewError.current, view }),
    [snapshot.current, error.current, viewError.current, view],
  );
  return {
    data: rawData,

    action: async (name: string, args: Record<string, string>) => {
      if (name === 'conversationView') {
        const result = await request<import('@cat-cafe/shared').ConversationViewPreferenceSnapshot>(
          '/api/config/conversation-view',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId, view: args.v ? { mode: 'cat', catId: args.v } : { mode: 'group' } }),
          },
        );
        viewError.current = null;
        setView({ threadId, value: result });
        ui.viewCat = result.effective.mode === 'cat' ? result.effective.catId : null;
        changed((n) => n + 1);
        return true;
      }
      if (name !== 'systemSend') return false;
      snapshot.current = await request<MessageDispositionPreferenceSnapshot>('/api/config/message-disposition', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'global', disposition: args.v === 'current' ? 'continue_current' : 'next_work' }),
      });
      error.current = null;
      changed((n) => n + 1);
      return true;
    },
  };
}
