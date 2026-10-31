import type { ContentModificationRecord } from '@cat-cafe/shared';
import { useSyncExternalStore } from 'react';

/**
 * The exact Workspace navigation a receipt click produced: the conversation it was made in and the revision the
 * chat store gave that open request. Revisions only ever grow, so a later revision means a newer navigation.
 */
export interface ModificationNavigation {
  readonly threadId: string;
  readonly revision: number;
}

/**
 * A person asked, from a Host receipt in the conversation, to see one candidate of one modification request in the
 * Workspace. The file opens through the normal Workspace navigation and may mount its modification entry later (or
 * already be on screen), so the ask waits here until the entry for the same object takes it. It belongs to that one
 * navigation: it is taken only while that navigation is still the newest one in its own conversation, and it is
 * retired the moment a newer one replaces it. No clock decides this; a slow mount never loses an accepted click.
 */
export interface ModificationFocus {
  /** The request exactly as the owner read it for the receipt; the entry derives the object identity from it. */
  readonly record: ContentModificationRecord;
  /** The candidate the receipt names; absent when the receipt only asks for the file. */
  readonly candidateRef?: string;
  /**
   * The exact version a media candidate is, when it is one. A request made on a published work or a Task round has
   * no file: its returned version is a round of the original review, and the round surface recognises its own round
   * by this identity (the same `contentRef` and `ownerRevision` its asset carries).
   */
  readonly asset?: ModificationFocusAsset;
  readonly navigation: ModificationNavigation;
}

export interface ModificationFocusAsset {
  readonly contentRef: string;
  readonly ownerRevision: number;
}

/** Where the Workspace's navigation stands right now. */
export interface WorkspaceNavigationState {
  readonly threadId: string | null;
  readonly revision: number;
}

/**
 * `ours`: the navigation this ask came from is still the newest, in this conversation.
 * `elsewhere`: another conversation is current; the ask is not for it and waits (a newer navigation retires it).
 * `superseded`: a newer navigation replaced the one this ask came from; it can never be taken.
 */
export type ModificationFocusStanding = 'ours' | 'elsewhere' | 'superseded';

export function modificationFocusStanding(
  focus: ModificationFocus,
  current: WorkspaceNavigationState,
): ModificationFocusStanding {
  if (current.revision !== focus.navigation.revision) return 'superseded';
  return current.threadId === focus.navigation.threadId ? 'ours' : 'elsewhere';
}

let pending: ModificationFocus | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function focusModification(input: {
  record: ContentModificationRecord;
  candidateRef?: string;
  asset?: ModificationFocusAsset;
  navigation: ModificationNavigation;
}): void {
  pending = { ...input };
  emit();
}

/** Drops the pending ask; with `only`, drops it only if it is still that very ask (a newer one stays). */
export function clearModificationFocus(only?: ModificationFocus): void {
  if (!pending || (only && pending !== only)) return;
  pending = null;
  emit();
}

export function usePendingModificationFocus(): ModificationFocus | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
