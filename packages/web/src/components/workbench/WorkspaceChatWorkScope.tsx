'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from 'react';

type WorkRegistration = {
  threadId: string;
  surfaceId: string;
  attachment: MediaContextAttachment;
  isVisible: () => boolean;
};
type WorkScope = {
  register: (work: WorkRegistration) => () => void;
  read: (threadId: string) => MediaContextAttachment | null;
};
const WorkScopeContext = createContext<WorkScope | null>(null);
const WorkSurfaceContext = createContext<string | null>(null);

/** Presentation-only context; one explicit send may read it, never the persistent composer draft. */
export function WorkspaceChatWorkScopeProvider({
  threadId,
  getActiveSurfaceId,
  isHostVisible,
  onRegisteredWorkChange,
  children,
}: {
  threadId: string;
  getActiveSurfaceId: () => string | null;
  isHostVisible: () => boolean;
  onRegisteredWorkChange?: (surfaceId: string | null) => void;
  children: ReactNode;
}) {
  const host = useRef({ threadId, getActiveSurfaceId, isHostVisible, onRegisteredWorkChange });
  host.current = { threadId, getActiveSurfaceId, isHostVisible, onRegisteredWorkChange };
  const scope = useMemo<WorkScope>(() => {
    const registrations = new Map<string, WorkRegistration>();
    const notify = () => {
      const current = host.current;
      const active = current.getActiveSurfaceId();
      const work = active ? registrations.get(active) : null;
      current.onRegisteredWorkChange?.(work?.threadId === current.threadId && current.isHostVisible() ? active : null);
    };
    return {
      register(work) {
        registrations.set(work.surfaceId, work);
        notify();
        return () => {
          if (registrations.get(work.surfaceId) === work) {
            registrations.delete(work.surfaceId);
            notify();
          }
        };
      },
      read(requestThreadId) {
        const current = host.current;
        if (requestThreadId !== current.threadId || !current.isHostVisible()) return null;
        const active = current.getActiveSurfaceId();
        const work = active ? registrations.get(active) : undefined;
        if (work?.threadId !== requestThreadId || !work.isVisible()) return null;
        return work.attachment;
      },
    };
  }, []);
  return <WorkScopeContext.Provider value={scope}>{children}</WorkScopeContext.Provider>;
}

export function WorkspaceChatWorkSurface({ surfaceId, children }: { surfaceId: string; children: ReactNode }) {
  return <WorkSurfaceContext.Provider value={surfaceId}>{children}</WorkSurfaceContext.Provider>;
}

export function useWorkspaceChatWorkScope(): WorkScope | null {
  return useContext(WorkScopeContext);
}

export function useRegisterWorkspaceChatWork(
  threadId: string | null,
  attachment: MediaContextAttachment | null,
  isVisible: () => boolean,
): void {
  const scope = useWorkspaceChatWorkScope();
  const surfaceId = useContext(WorkSurfaceContext);
  const current = useRef({ attachment, isVisible });
  current.current = { attachment, isVisible };
  const sourceKey = JSON.stringify(attachment);
  useLayoutEffect(() => {
    const value = current.current.attachment;
    if (scope && surfaceId && threadId && sourceKey !== 'null' && value)
      return scope.register({ threadId, surfaceId, attachment: value, isVisible: () => current.current.isVisible() });
  }, [scope, surfaceId, threadId, sourceKey]);
}

/** The retained owner may be mounted inside a hidden chooser, comparison, or inactive pane. */
export function isChatWorkElementVisible(element: HTMLElement | null): boolean {
  return Boolean(
    element?.isConnected &&
      !element.closest('[hidden], [aria-hidden="true"], .hidden') &&
      element.getClientRects().length,
  );
}
