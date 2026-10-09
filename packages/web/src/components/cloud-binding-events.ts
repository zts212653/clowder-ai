'use client';

import { useEffect, useRef } from 'react';

export const CLOUD_BINDING_CHANGED = 'cat-cafe:cloud-binding-changed';

interface CloudBindingChange {
  threadId: string;
  /** Who wrote: a surface does not re-read after its own writes. */
  source: string;
}

/**
 * A thread's cloud binding may have changed. The thread panel and a message's recovery card can both
 * show and write the same binding; each announces its writes so that the other reads it again.
 */
export function announceCloudBindingChange(threadId: string, source: string): void {
  window.dispatchEvent(new CustomEvent<CloudBindingChange>(CLOUD_BINDING_CHANGED, { detail: { threadId, source } }));
}

/** Calls `onChange` whenever another surface announces a change to this thread's binding. */
export function useCloudBindingChanges(threadId: string, source: string, onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const listener = (event: Event) => {
      const change = (event as CustomEvent<CloudBindingChange>).detail;
      if (change?.threadId === threadId && change.source !== source) onChangeRef.current();
    };
    window.addEventListener(CLOUD_BINDING_CHANGED, listener);
    return () => window.removeEventListener(CLOUD_BINDING_CHANGED, listener);
  }, [threadId, source]);
}
