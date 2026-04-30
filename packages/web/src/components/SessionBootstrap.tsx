'use client';

import { useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';

let established = false;

export function SessionBootstrap() {
  useEffect(() => {
    if (established) return;
    established = true;
    fetch(`${API_URL}/api/session`, { credentials: 'include' }).catch(() => {});
    try {
      const stored = window.localStorage.getItem('catcafe.ui.thinkingExpandedByDefault');
      if (stored === '1') useChatStore.getState().setUiThinkingExpandedByDefault(true);
    } catch {}
  }, []);
  return null;
}
