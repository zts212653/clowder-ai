// Drop-in for '@/components/thread-chat/hub-socket-context' in unit tests that render a
// shared-connection consumer (Teleport, workspace navigation, file watching, home actions)
// without ThreadChatRuntimeProvider. The page connection stays disconnected, so consumers
// hold their listeners and rooms but send nothing.
//
//   vi.mock('@/components/thread-chat/hub-socket-context', () => import('@/test-utils/hub-socket-context-mock'));
import { createContext } from 'react';
import type { HubSocket } from '@/hooks/useSocket-hub';
import { createFakeHubSocket } from './fake-hub-socket-core';

const disconnectedPage = createFakeHubSocket();

export const HubSocketContext = createContext<HubSocket | null>(null);

export function useHubSocket(): HubSocket {
  return disconnectedPage.hub;
}
