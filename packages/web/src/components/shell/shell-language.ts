'use client';

/**
 * F322 AC-B6–B8 — the one language preference of the new shell (v2): 中文 or English.
 *
 * Same shape and same reasons as `shell-presentation.ts`, its sibling: a browser-local preference (like the theme, the pinned
 * sections and the presentation switch), read through `useSyncExternalStore`, never a store that gates data, permissions or
 * routing. Choosing a language only changes which words a v2 surface reads from its dictionary (`shell-copy/`); it does not
 * remount anything, so a draft, a reading position, a selection and a running execution all stay where they were.
 *
 * - Persisted with no expiry (user state defaults to durable): the stored value is the bare language, nothing that can lapse.
 * - Classic never reads it. The classic shell is unchanged by this round (operator 087), so no classic surface imports this file.
 * - The speech-recognition `language` of the audio services is a different thing and is not this one.
 * - There is no control for it yet: the switch is not designed, so none is built here. Whoever draws it calls
 *   `writeShellLanguage`; until then a language is chosen by setting `localStorage['cat-cafe:shell-language']`.
 */

import { useSyncExternalStore } from 'react';

export type ShellLanguage = 'zh' | 'en';

export const DEFAULT_SHELL_LANGUAGE: ShellLanguage = 'zh';
export const SHELL_LANGUAGE_STORAGE_KEY = 'cat-cafe:shell-language';
const SYNC_EVENT = 'cat-cafe:shell-language-sync';

/**
 * This tab's own latest choice, kept only when storage refused to take it (private mode, quota). It is what this tab's user
 * last asked for, so it outranks whatever older value storage still holds — otherwise the click would be undone on the next
 * read. It ends the moment storage speaks again: a write that does reach storage replaces it, and so does any change another
 * tab makes (a `storage` event for this key, or one with no key at all — all storage cleared), because that is a newer
 * decision than a choice this tab could not even save. That last part must not depend on any reader being mounted — leaving
 * v2 removes every reader, and a remote decision made meanwhile still has to win on the way back — so it is watched by its own
 * listener from the moment the choice is kept until the moment it is dropped.
 */
let unstoredChoice: ShellLanguage | null = null;
let stopWatchingForNewerDecision: (() => void) | null = null;

function isNewerDecision(event: StorageEvent): boolean {
  // key === null: another tab cleared everything, so this key may have changed too.
  return event.key === null || event.key === SHELL_LANGUAGE_STORAGE_KEY;
}

function dropUnstoredChoice(): void {
  unstoredChoice = null;
  stopWatchingForNewerDecision?.();
}

function keepUnstoredChoice(choice: ShellLanguage): void {
  unstoredChoice = choice;
  if (stopWatchingForNewerDecision) return;
  const onStorage = (event: StorageEvent) => {
    if (isNewerDecision(event)) dropUnstoredChoice();
  };
  window.addEventListener('storage', onStorage);
  stopWatchingForNewerDecision = () => {
    window.removeEventListener('storage', onStorage);
    stopWatchingForNewerDecision = null;
  };
}

export function parseShellLanguage(value: unknown): ShellLanguage | null {
  return value === 'zh' || value === 'en' ? value : null;
}

export function readShellLanguage(): ShellLanguage {
  if (typeof window === 'undefined') return DEFAULT_SHELL_LANGUAGE;
  if (unstoredChoice) return unstoredChoice;
  try {
    return parseShellLanguage(window.localStorage.getItem(SHELL_LANGUAGE_STORAGE_KEY)) ?? DEFAULT_SHELL_LANGUAGE;
  } catch {
    return DEFAULT_SHELL_LANGUAGE;
  }
}

export function writeShellLanguage(next: ShellLanguage): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, next);
    dropUnstoredChoice();
  } catch {
    keepUnstoredChoice(next);
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (!isNewerDecision(event)) return;
    dropUnstoredChoice(); // before the read below, whichever listener runs first
    onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SYNC_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SYNC_EVENT, onChange);
  };
}

export function useShellLanguage(): ShellLanguage {
  return useSyncExternalStore(subscribe, readShellLanguage, () => DEFAULT_SHELL_LANGUAGE);
}
