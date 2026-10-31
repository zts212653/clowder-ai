'use client';

import { createContext, type ReactNode, useCallback, useContext } from 'react';

type RequestChatReveal = (threadId: string) => void;
const WorkspaceChatReveal = createContext<RequestChatReveal | null>(null);

/** The Chat host owns visibility; a content leaf can only request its own conversation. */
export function WorkspaceChatRevealProvider({
  threadId,
  onReveal,
  children,
}: {
  threadId: string;
  onReveal: () => void;
  children: ReactNode;
}) {
  const request = useCallback(
    (requestedThreadId: string) => {
      if (requestedThreadId === threadId) onReveal();
    },
    [threadId, onReveal],
  );
  return <WorkspaceChatReveal.Provider value={request}>{children}</WorkspaceChatReveal.Provider>;
}

/** No alternate composer or owner is created outside the original Chat host. */
export function useWorkspaceChatReveal() {
  return useContext(WorkspaceChatReveal);
}
