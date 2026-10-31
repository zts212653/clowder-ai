'use client';

import { useEffect } from 'react';
import { watchConciergeDesktop } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { openCompanionConversation } from './companion-entry';

/** Root owner for shared configuration and desktop observations. It renders no body. */
export function ConciergeHost() {
  const fetchConfig = useConciergeStore((state) => state.fetchConfig);
  const readExistingThreadId = useConciergeStore((state) => state.readExistingThreadId);
  const surfaceState = useConciergeStore((state) => state.surfaceState);
  useEffect(watchConciergeDesktop, []);
  useEffect(() => {
    void fetchConfig();
    void readExistingThreadId();
  }, [fetchConfig, readExistingThreadId]);
  // Existing capability tips carry an explicit draft, not permission to revive a floating shell.
  useEffect(() => {
    if (surfaceState === 'bubble') void openCompanionConversation();
  }, [surfaceState]);
  return null;
}
