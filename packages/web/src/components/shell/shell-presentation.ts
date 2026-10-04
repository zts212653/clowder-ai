'use client';

/**
 * F322 Stage 1 — the one presentation switch for the Café 1.6 shell.
 *
 * "Workspace 新版" only selects how the same canonical data is presented: classic keeps the
 * old ActivityBar / sidebar header / chat header byte-for-byte, v2 renders the decided 1.6 shell.
 * It is a browser-local preference (like the theme and pinned sections) and never gates data,
 * permissions or any store. `?shell=v2` / `?shell=classic` in the URL sets it once so the state
 * can be shared by link and verified in a real browser; the choice then persists.
 */

import { useSyncExternalStore } from 'react';

export type ShellPresentation = 'classic' | 'v2';

export const SHELL_PRESENTATION_STORAGE_KEY = 'cat-cafe:shell-presentation';
const SYNC_EVENT = 'cat-cafe:shell-presentation-sync';

export function parseShellPresentation(value: unknown): ShellPresentation | null {
  return value === 'v2' || value === 'classic' ? value : null;
}

export function readShellPresentation(): ShellPresentation {
  if (typeof window === 'undefined') return 'classic';
  try {
    return parseShellPresentation(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)) ?? 'classic';
  } catch {
    return 'classic';
  }
}

export function writeShellPresentation(next: ShellPresentation): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, next);
  } catch {
    /* Private mode / quota: the in-tab event below still flips this tab. */
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

/** Read `?shell=` once; returns the requested presentation without touching storage. */
export function parseShellPresentationParam(search: string): ShellPresentation | null {
  return parseShellPresentation(new URLSearchParams(search).get('shell'));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SHELL_PRESENTATION_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SYNC_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SYNC_EVENT, onChange);
  };
}

export function useShellPresentation(): ShellPresentation {
  return useSyncExternalStore(subscribe, readShellPresentation, () => 'classic');
}
