'use client';

import { useSyncExternalStore } from 'react';
import { getCoCreatorMentionPatterns, subscribeCoCreatorMentionData } from '@/lib/mention-highlight';

/** Observe the shell's existing owner-config projection without adding another fetch. */
export function useCoCreatorMentionPatterns(): readonly string[] {
  return useSyncExternalStore(subscribeCoCreatorMentionData, getCoCreatorMentionPatterns, getCoCreatorMentionPatterns);
}
