'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useToastStore } from '@/stores/toastStore';
import type { ChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import { isSettingsRoute, SettingsReadingBridge, type SettingsReadingView } from './settings-reading-bridge';
import { claimSettingsReadingScope } from './settings-reading-scope';
import { settingsReadingSessionKey } from './settings-reading-session';
import { settingsReturnCopy } from './settings-source-return.shell-copy';
import type { SettingsSourceReturn } from './settings-source-return.types';
import { useShellCopy } from './shell-copy';

const EMPTY: SettingsReadingView = { source: null, persisted: true, returning: false, notice: null };
const serverSnapshot = () => EMPTY;
const noopSubscribe = () => () => {};
const Context = createContext<{ bridge: SettingsReadingBridge; pathname: string; enabled: boolean } | null>(null);

function ReturnNotice({ bridge }: { bridge: SettingsReadingBridge }) {
  const view = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, serverSnapshot);
  const copy = useShellCopy(settingsReturnCopy);
  useEffect(() => {
    const notice = bridge.consumeNotice(view);
    if (!notice) return;
    const messages = {
      'not-saved': copy.notSaved,
      unavailable: copy.unavailable,
      interrupted: copy.interrupted,
      'clear-failed': copy.clearFailed,
      'save-failed': copy.saveFailed,
    };
    useToastStore.getState().addToast({
      type: notice === 'not-saved' ? 'info' : 'error',
      title: copy.title,
      message: messages[notice],
      duration: 0,
    });
    bridge.noticePresented(notice);
  }, [bridge, view, copy]);
  return null;
}

/** AppShell survives the route transition; chat owns the port and reading geometry. */
export function SettingsSourceReturnProvider({
  pathname,
  enabled,
  children,
}: {
  pathname: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [bridge, setBridge] = useState<SettingsReadingBridge | null>(() =>
    typeof window !== 'undefined' && !navigator.locks
      ? new SettingsReadingBridge((path) => routerRef.current.push(path), undefined, false)
      : null,
  );
  useEffect(() => {
    if (bridge) return;
    let active = true;
    void claimSettingsReadingScope().then((scope) => {
      if (active)
        setBridge(new SettingsReadingBridge((path) => routerRef.current.push(path), scope.id, scope.restorable));
    });
    return () => {
      active = false;
    };
  }, [bridge]);
  useLayoutEffect(() => {
    bridge?.setRoute(pathname, enabled);
  }, [bridge, pathname, enabled]);
  useEffect(() => {
    if (!bridge) return;
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === settingsReadingSessionKey()) bridge.storageChanged();
    };
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('storage', storage);
      bridge.dispose();
    };
  }, [bridge]);
  const context = useMemo(() => (bridge ? { bridge, pathname, enabled } : null), [bridge, pathname, enabled]);
  return (
    <Context.Provider value={context}>
      {children}
      {enabled && bridge && <ReturnNotice bridge={bridge} />}
    </Context.Provider>
  );
}

/** B's Settings shell reads the real origin without interpreting route referrers. */
export function useSettingsSourceReturn(): SettingsSourceReturn {
  const context = useContext(Context);
  const view = useSyncExternalStore(
    context?.bridge.subscribe ?? noopSubscribe,
    context?.bridge.getSnapshot ?? serverSnapshot,
    serverSnapshot,
  );
  const source = view.source;
  return useMemo(() => {
    if (!context?.enabled || !isSettingsRoute(context.pathname) || !source?.label.trim()) return null;
    return {
      label: source.label,
      onReturn: () => {
        void context.bridge.returnToSource(source.id);
      },
    };
  }, [context, source]);
}

/** Entry consumer: capture happens on the actual Settings navigation, never on a render. */
export function useSettingsReadingEntry(): () => void {
  const bridge = useContext(Context)?.bridge;
  return useCallback(() => {
    bridge?.captureBeforeSettings();
  }, [bridge]);
}

/** Title hydration is metadata; it cannot retire a mounted reader that is restoring. */
export function useSettingsReadingPort(label: string | null): (port: ChatReadingPort) => () => void {
  const bridge = useContext(Context)?.bridge;
  const labelRef = useRef(label);
  useLayoutEffect(() => {
    labelRef.current = label;
  }, [label]);
  return useCallback((port) => bridge?.registerReadingPort(port, () => labelRef.current) ?? (() => {}), [bridge]);
}
