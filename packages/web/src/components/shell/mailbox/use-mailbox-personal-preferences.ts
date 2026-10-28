import {
  ignoredItemKey,
  type UnifiedAttentionItemV1,
  type UnifiedAttentionPreferenceCoordinate,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIgnoredItemPreferences } from '@/hooks/useIgnoredItemPreferences';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { useMailboxFeedback } from './mailbox-feedback';
import {
  type PersonalActionRefusal,
  type PersonalActionSource,
  personalSourceRefusal,
} from './personal-action-eligibility';

export interface MailboxPersonalActions {
  mode: 'visible' | 'ignored';
  refusal: (item: UnifiedAttentionItemV1) => PersonalActionRefusal | null;
  change: (item: UnifiedAttentionItemV1, restore?: boolean) => Promise<boolean>;
}

type Undo = { owner: string; coordinates: UnifiedAttentionPreferenceCoordinate[]; source: PersonalActionSource };
const sourceOf = (item: UnifiedAttentionItemV1): PersonalActionSource => {
  if (item.collectiveAccountabilityRequest || item.collectiveProjectAttention) return 'all';
  if (item.kind === 'user_mention' && item.userMention) return 'mentions';
  if (item.runtimeInteraction || item.choiceRequest) return 'structuredChoices';
  if (item.approval) return 'approvals';
  if (item.linkedNeedsMe.length > 0) return 'needsMe';
  return 'all';
};

/** Owner-private writes retain their identity/revision fence; each operation proves its own source. */
export function useMailboxPersonalPreferences(view: UnifiedAttentionView) {
  const acknowledge = useMailboxFeedback();
  const read = view.result.kind === 'ok' ? view.result.read : null;
  const personal = read?.personalView;
  const preferences = useIgnoredItemPreferences(read?.identity.ownerUserId, personal !== undefined);
  const currentView = useRef(view);
  currentView.current = view;
  const currentPreferences = useRef(preferences);
  currentPreferences.current = preferences;
  const [undo, setUndo] = useState<Undo | null>(null);
  const [actionError, setActionError] = useState<{ owner: string; error: 'conflict' | 'unavailable' } | null>(null);
  const displayOwner = (read ?? view.staleRead)?.identity.ownerUserId;
  useEffect(() => {
    if (displayOwner && actionError && displayOwner !== actionError.owner) setActionError(null);
  }, [displayOwner, actionError]);
  const dismissUndo = useCallback(() => setUndo(null), []);
  const refuse = () => {
    setActionError(displayOwner ? { owner: displayOwner, error: 'conflict' } : null);
    currentView.current.refetch();
    return false;
  };
  const refusal = (source: PersonalActionSource): PersonalActionRefusal | null => {
    const live = currentView.current;
    const prefs = currentPreferences.current;
    if (!read || !personal || live.result !== view.result || live.resultGeneration !== live.readsStarted())
      return 'refreshing';
    if (prefs.saving) return 'saving';
    if (prefs.error === 'unavailable') return 'preferences';
    if (!prefs.ready) return 'identity';
    if (read.identity.ownerUserId !== prefs.snapshot?.ownerUserId) return 'identity';
    if (personal.preferenceRevision !== prefs.snapshot?.revision) return 'changed';
    return personalSourceRefusal(read, source);
  };
  const containsPreferences = (coordinates: UnifiedAttentionPreferenceCoordinate[]) => {
    const keys = new Set(currentPreferences.current.snapshot?.entries.map((entry) => ignoredItemKey(entry.coordinate)));
    return coordinates.every((coordinate) => keys.has(ignoredItemKey(coordinate)));
  };
  const itemRefusal = (item: UnifiedAttentionItemV1): PersonalActionRefusal | null => {
    const reason = refusal(sourceOf(item));
    if (reason) return reason;
    const coordinate = item.preferenceCoordinate;
    if (!coordinate) return 'changed';
    const matches = (currentView.current.currentPages ?? currentView.current.pages ?? (read ? [read] : []))
      .filter(
        (page) =>
          page.identity.ownerUserId === read?.identity.ownerUserId &&
          page.personalView?.preferenceRevision === personal?.preferenceRevision,
      )
      .flatMap((page) => page.items)
      .filter(
        (current) =>
          current.preferenceCoordinate && ignoredItemKey(current.preferenceCoordinate) === ignoredItemKey(coordinate),
      );
    if (matches?.length !== 1 || sourceOf(matches[0]) !== sourceOf(item)) return 'changed';
    if (personal?.mode === 'ignored' && !containsPreferences([coordinate])) return 'changed';
    return null;
  };
  const save = async (
    coordinates: UnifiedAttentionPreferenceCoordinate[],
    restore: boolean,
    source: PersonalActionSource,
  ) => {
    const live = currentView.current;
    if (refusal(source) || !read || coordinates.length === 0 || (restore && !containsPreferences(coordinates))) {
      return refuse();
    }
    setActionError(null);
    const result = await currentPreferences.current.changeWithResult(
      restore ? [] : coordinates,
      restore ? coordinates : [],
    );
    if (result.saved && !restore) {
      setUndo({ owner: read.identity.ownerUserId, coordinates, source });
      acknowledge({ owner: read.identity.ownerUserId, result: 'ignored', coordinates });
    }
    if (result.saved && restore) setUndo(null);
    if (!result.saved) {
      // Preserve the terminal write failure across the next identity/read refresh.
      setActionError({ owner: read.identity.ownerUserId, error: result.error });
      live.refetch();
    }
    return result.saved;
  };
  const actions: MailboxPersonalActions | undefined = personal
    ? {
        mode: personal.mode,
        refusal: itemRefusal,
        change: (item, restore = false) => {
          if (itemRefusal(item) || !item.preferenceCoordinate || restore !== (personal.mode === 'ignored'))
            return Promise.resolve(refuse());
          return save([item.preferenceCoordinate], restore, sourceOf(item));
        },
      }
    : undefined;
  const visibleUndo =
    undo && read?.identity.ownerUserId === undo.owner && preferences.snapshot?.ownerUserId === undo.owner ? undo : null;
  return {
    actions,
    ignoredEntries: preferences.snapshot?.entries ?? [],
    batchRefusal: refusal('mentions'),
    restoreBatchRefusal: refusal('all'),
    undoRefusal: visibleUndo
      ? (refusal(visibleUndo.source) ?? (containsPreferences(visibleUndo.coordinates) ? null : ('changed' as const)))
      : ('changed' as const),
    error: actionError && actionError.owner === displayOwner ? actionError.error : preferences.error,
    loading: preferences.loading,
    saving: preferences.saving,
    undo: visibleUndo,
    ignoreBatch: (coordinates: UnifiedAttentionPreferenceCoordinate[], owner: string, revision: number) =>
      read?.identity.ownerUserId === owner && currentPreferences.current.snapshot?.revision === revision
        ? save(coordinates, false, 'mentions')
        : Promise.resolve(refuse()),
    restoreBatch: (items: UnifiedAttentionItemV1[]) =>
      personal?.mode === 'ignored' &&
      items.length > 0 &&
      items.every((item) => !itemRefusal(item) && item.preferenceCoordinate)
        ? save(
            items.flatMap((item) => (item.preferenceCoordinate ? [item.preferenceCoordinate] : [])),
            true,
            'all',
          )
        : Promise.resolve(refuse()),
    dismissUndo,
    undoLast: () => (visibleUndo ? save(visibleUndo.coordinates, true, visibleUndo.source) : Promise.resolve(false)),
  };
}
