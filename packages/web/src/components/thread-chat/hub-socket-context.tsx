'use client';

import { createContext, useContext } from 'react';
import type { HubSocket } from '@/hooks/useSocket-hub';

/** The page's one Socket.IO connection, provided by ThreadChatRuntimeProvider in AppShell. */
export const HubSocketContext = createContext<HubSocket | null>(null);

export function useHubSocket(): HubSocket {
  const hub = useContext(HubSocketContext);
  if (!hub) throw new Error('useHubSocket must be used within ThreadChatRuntimeProvider');
  return hub;
}
