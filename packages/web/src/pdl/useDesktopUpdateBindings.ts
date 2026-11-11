'use client';
import { useEffect, useState } from 'react';

interface DesktopUpdateRead {
  available: boolean;
  currentVersion: string | null;
  load: '' | 'loading';
  settings: DesktopUpdateSettings | null;
  prompt: DesktopUpdatePromptPayload | null;
  progress: DesktopUpdateProgressPayload | null;
  error: unknown;
}

/** Native update data and commands; the copied system view owns their presentation. */
export function useDesktopUpdateBindings() {
  const [read, setRead] = useState<DesktopUpdateRead>({
    available: false,
    currentVersion: null,
    load: 'loading',
    settings: null,
    prompt: null,
    progress: null,
    error: null,
  });
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setRead((previous) => ({
      ...previous,
      available: true,
      currentVersion: new URLSearchParams(window.location.search).get('__clowder_desktop_version'),
    }));
    let active = true;
    const stopPrompt = bridge.onUpdatePrompt((prompt) => {
      if (active) setRead((previous) => ({ ...previous, prompt }));
    });
    const stopProgress = bridge.onUpdateProgress((progress) => {
      if (active) setRead((previous) => ({ ...previous, progress }));
    });
    void Promise.all([bridge.getUpdateSettings(), bridge.updatePromptReady()]).then(
      ([settings, prompt]) => {
        if (active) setRead((previous) => ({ ...previous, load: '', settings, prompt, error: null }));
      },
      (error: unknown) => {
        if (active) setRead((previous) => ({ ...previous, load: '', settings: null, prompt: null, error }));
      },
    );
    return () => {
      active = false;
      stopPrompt();
      stopProgress();
    };
  }, []);
  const action = async (name: string, args: Record<string, string>) => {
    if (!['desktop:check', 'desktop:autoCheck', 'desktop:action'].includes(name)) return false;
    const bridge = window.desktopBridge as DesktopBridge;
    if (name === 'desktop:check') await bridge.checkForUpdates();
    else if (name === 'desktop:autoCheck') {
      const settings = await bridge.setUpdateAutoCheck(
        args.autoCheck === 'true' || (args.autoCheck as unknown) === true,
      );
      setRead((previous) => ({ ...previous, settings }));
    } else {
      bridge.sendUpdatePromptAction(args.action as DesktopUpdatePromptAction, args.version);
      const prompt = await bridge.updatePromptReady();
      setRead((previous) => ({ ...previous, prompt }));
    }
    return true;
  };
  return { action, data: read };
}
