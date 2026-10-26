'use client';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

type WorkModeAction = { run: () => void; busy: boolean };
type Slots = {
  workMode: WorkModeAction | null;
  setWorkMode: (action: WorkModeAction | null) => void;
  history: (() => void) | null;
  setHistory: (action: (() => void) | null) => void;
  version: HTMLDivElement | null;
  actions: HTMLDivElement | null;
  setVersion: (element: HTMLDivElement | null) => void;
  setActions: (element: HTMLDivElement | null) => void;
};
const Context = createContext<Slots | null>(null);
const ActionsVisible = createContext(true);
/** The visible media owns the one action row, including during owner admission. */
export function ArtworkActionsVisibility({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <ActionsVisible.Provider value={visible}>{children}</ActionsVisible.Provider>;
}
export function useArtworkActionsVisible() {
  return useContext(ActionsVisible);
}
/** Presentation slots only: the original surface still owns versions, media and actions. */
export function ArtworkChromeProvider({ children }: { children: ReactNode }) {
  const parent = useContext(Context);
  const [version, setVersion] = useState<HTMLDivElement | null>(null);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [workMode, setWorkMode] = useState<WorkModeAction | null>(null);
  const [history, updateHistory] = useState<(() => void) | null>(null);
  const setHistory = useCallback((action: (() => void) | null) => updateHistory(() => action), []);
  const value = useMemo(
    () => ({ version, actions, setVersion, setActions, history, setHistory, workMode, setWorkMode }),
    [version, actions, history, setHistory, workMode],
  );
  return parent ? children : <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useArtworkChrome() {
  return useContext(Context);
}

export function useRegisterArtworkHistory(open: () => void) {
  const setter = useArtworkChrome()?.setHistory;
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    setter?.(() => latest.current());
    return () => setter?.(null);
  }, [setter]);
}

export function useRegisterArtworkWorkMode(open: (() => void) | undefined, busy: boolean) {
  const setter = useArtworkChrome()?.setWorkMode;
  const latest = useRef(open);
  latest.current = open;
  const enabled = !!open;
  useEffect(() => {
    setter?.(enabled ? { run: () => latest.current?.(), busy } : null);
    return () => setter?.(null);
  }, [setter, enabled, busy]);
}
