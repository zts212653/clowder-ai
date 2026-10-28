'use client';

import { createContext, useContext } from 'react';
import { focusLineageMessage } from '@/utils/focusLineageMessage';

// The mounted chat surface supplies its existing reading owner. Standalone
// message previews retain their DOM-only navigation without owning chat memory.
export interface MessageNavigationOptions {
  loadIfNeeded?: boolean;
}
const MessageNavigationContext =
  createContext<(messageId: string, options?: MessageNavigationOptions) => boolean>(focusLineageMessage);

export const MessageNavigationProvider = MessageNavigationContext.Provider;

export function useMessageNavigation(): (messageId: string, options?: MessageNavigationOptions) => boolean {
  return useContext(MessageNavigationContext);
}
