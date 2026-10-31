'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DesktopUpdateProgressCard } from './DesktopUpdateProgressCard';
import { DesktopUpdatePromptDialog } from './DesktopUpdatePromptDialog';
import { getFocusableElements } from './guide-overlay/helpers';

const TERMINAL_ACTIONS = new Set<DesktopUpdatePromptAction>(['download', 'install', 'later', 'skip', 'dismiss']);

function containTabFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(dialog);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  let next: HTMLElement | null = null;

  if (!dialog || !first || !last) next = dialog;
  else if (!active || active === dialog || !dialog.contains(active)) next = event.shiftKey ? last : first;
  else if (event.shiftKey && active === first) next = last;
  else if (!event.shiftKey && active === last) next = first;

  if (!next) return;
  event.preventDefault();
  next.focus();
}

export function DesktopUpdatePrompt() {
  const [prompt, setPrompt] = useState<DesktopUpdatePromptPayload | null>(null);
  const [progress, setProgress] = useState<DesktopUpdateProgressPayload | null>(null);
  const [progressHidden, setProgressHidden] = useState(false);
  const progressActive = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const promptOpen = prompt !== null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onUpdatePrompt((nextPrompt) => setPrompt(nextPrompt));
    const unsubscribeProgress = bridge.onUpdateProgress((nextProgress) => {
      const startsTransfer = nextProgress !== null && !progressActive.current;
      progressActive.current = nextProgress !== null;
      setProgress(nextProgress);
      if (startsTransfer || nextProgress === null) setProgressHidden(false);
    });
    void bridge
      .updatePromptReady()
      .then((pendingPrompt) => {
        if (active && pendingPrompt) setPrompt(pendingPrompt);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
      unsubscribeProgress();
    };
  }, []);

  const sendAction = useCallback(
    (action: DesktopUpdatePromptAction) => {
      if (!prompt || !window.desktopBridge) return;
      window.desktopBridge.sendUpdatePromptAction(action, prompt.version);
      if (TERMINAL_ACTIONS.has(action)) setPrompt(null);
    },
    [prompt],
  );

  useEffect(() => {
    if (!promptOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [promptOpen]);

  useEffect(() => {
    if (!prompt) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        sendAction(prompt.kind === 'up-to-date' || prompt.kind === 'check-failed' ? 'dismiss' : 'later');
        return;
      }
      containTabFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prompt, sendAction]);

  return (
    <>
      {prompt && <DesktopUpdatePromptDialog prompt={prompt} dialogRef={dialogRef} sendAction={sendAction} />}
      {progress && !progressHidden && (
        <DesktopUpdateProgressCard progress={progress} onHide={() => setProgressHidden(true)} />
      )}
    </>
  );
}
