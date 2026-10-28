'use client';

import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { apiFetch } from '@/utils/api-client';
import { executeSidebarFieldCommand } from '@/utils/sidebar-commands';
import { useShellPresentation } from '../shell/shell-presentation';
import { ThreadSettingsPanel } from './ThreadSettingsPanel';
import { saveThreadLabels, saveThreadPreferredCats } from './thread-settings-commands';

type OpenSettings = (threadId: string, returnFocusRef: RefObject<HTMLElement | null>) => void;
const ThreadSettingsContext = createContext<{
  open: OpenSettings;
  toggle: OpenSettings;
  threadId: string | null;
} | null>(null);

/** The header and every sidebar row address one v2 surface. Classic keeps its row-local surface. */
export function ThreadSettingsProvider({ children, routeThreadId }: { children: ReactNode; routeThreadId: string }) {
  const isV2 = useShellPresentation() === 'v2';
  const [request, setRequest] = useState<{
    threadId: string;
    routeThreadId: string;
    returnFocusRef: RefObject<HTMLElement | null>;
  } | null>(null);
  const close = useCallback(() => setRequest(null), []);
  const open = useCallback<OpenSettings>(
    (threadId, returnFocusRef) => {
      if (threadId !== 'default') setRequest({ threadId, routeThreadId, returnFocusRef });
    },
    [routeThreadId],
  );
  const toggle = useCallback<OpenSettings>(
    (threadId, returnFocusRef) => {
      if (threadId === 'default') return;
      setRequest((current) =>
        current?.threadId === threadId && current.routeThreadId === routeThreadId
          ? null
          : { threadId, routeThreadId, returnFocusRef },
      );
    },
    [routeThreadId],
  );
  useEffect(() => {
    setRequest((current) => (!isV2 || current?.routeThreadId !== routeThreadId ? null : current));
  }, [routeThreadId, isV2]);
  const active = isV2 && request?.routeThreadId === routeThreadId ? request : null;
  const controller = useMemo(
    () => (isV2 ? { open, toggle, threadId: active?.threadId ?? null } : null),
    [isV2, open, toggle, active?.threadId],
  );

  return (
    <ThreadSettingsContext.Provider value={controller}>
      {children}
      {active && (
        <ThreadSettingsHost
          key={active.threadId}
          threadId={active.threadId}
          returnFocusRef={active.returnFocusRef}
          onClose={close}
        />
      )}
    </ThreadSettingsContext.Provider>
  );
}

export function useOpenThreadSettings() {
  return useThreadSettingsState()?.open ?? null;
}

export function useThreadSettingsState() {
  return useContext(ThreadSettingsContext);
}

function ThreadSettingsHost({
  threadId,
  returnFocusRef,
  onClose,
}: {
  threadId: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { currentThread, setExactThread } = useThreadDisplayInfo(threadId);
  if (!currentThread) return null;
  return (
    <ThreadSettingsPanel
      open
      threadId={threadId}
      threadTitle={currentThread.title ?? '未命名对话'}
      projectPath={currentThread.projectPath}
      currentCats={[...(currentThread.preferredCats ?? [])]}
      currentLabels={[...(currentThread.labels ?? [])]}
      onSavePreferredCats={saveThreadPreferredCats}
      onSaveLabels={saveThreadLabels}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      pinned={currentThread.pinned}
      onTogglePin={async () => {
        const pinned = !currentThread.pinned;
        const ok = await executeSidebarFieldCommand({
          threadId,
          field: 'pinned',
          value: pinned,
          request: (signal) =>
            apiFetch(`/api/threads/${threadId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pinned }),
              signal,
            }),
        });
        if (ok) setExactThread((previous) => (previous && !('error' in previous) ? { ...previous, pinned } : previous));
        return ok;
      }}
    />
  );
}
