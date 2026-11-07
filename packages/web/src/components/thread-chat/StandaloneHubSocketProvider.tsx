'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useHubSocketOutlet } from '@/hooks/useSocket-hub';
import { API_URL } from '@/utils/api-client';
import { HubSocketContext } from './hub-socket-context';

/**
 * The page connection for chromeless routes (story, showcase), which render without the chat
 * runtime. It exists so workspace navigation keeps queueing there (#3276), and it is still
 * the page's only connection; chat pages get theirs from ThreadChatRuntimeProvider.
 */
export function StandaloneHubSocketProvider({ children }: { children?: ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const { hub, attach, detach, reconcileOnConnect, resetOnDisconnect } = useHubSocketOutlet(socketRef);

  useEffect(() => {
    const apiUrl = new URL(API_URL);
    const socket = io(`${apiUrl.protocol}//${apiUrl.host}`, { transports: ['websocket'] });
    socketRef.current = socket;
    attach(socket);
    socket.on('connect', reconcileOnConnect);
    socket.on('disconnect', resetOnDisconnect);
    return () => {
      socket.off('connect', reconcileOnConnect);
      socket.off('disconnect', resetOnDisconnect);
      detach(socket);
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [attach, detach, reconcileOnConnect, resetOnDisconnect]);

  return <HubSocketContext.Provider value={hub}>{children}</HubSocketContext.Provider>;
}
