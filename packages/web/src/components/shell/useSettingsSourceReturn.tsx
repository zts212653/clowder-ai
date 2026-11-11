'use client';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import { isSettingsRoute, SettingsReadingBridge, type SettingsReadingView } from './settings-reading-bridge';
import type { SettingsSourceReturn } from './settings-source-return.types';

const EMPTY: SettingsReadingView = { source: null, persisted: true, returning: false, notice: null };
const serverSnapshot = () => EMPTY;
const noopSubscribe = () => () => {};
const Context = createContext<{ bridge: SettingsReadingBridge; pathname: string; enabled: boolean } | null>(null);

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
