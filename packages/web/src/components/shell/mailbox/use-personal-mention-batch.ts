import type { UnifiedAttentionPreferenceCoordinate, UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import type { UnifiedAttentionView } from '../use-unified-attention';
import {
  type MentionIgnorePeriod,
  type PersonalMentionPreview,
  personalMentionPreviewKey,
  readPersonalMentionPreview,
} from './personal-mention-preview';
import type { useMailboxPersonalPreferences } from './use-mailbox-personal-preferences';

/** Prepare and confirm both read the complete selected set, then use the original writer's owner/revision CAS. */
export function usePersonalMentionBatch(
  read: UnifiedAttentionReadV1 | null,
  view: UnifiedAttentionView,
  personal: ReturnType<typeof useMailboxPersonalPreferences>,
) {
  const [snapshot, setSnapshot] = useState<PersonalMentionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'empty' | 'unavailable' | 'changed' | null>(null);
  const latest = useRef({ read, view, personal });
  latest.current = { read, view, personal };
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A verified stale read can identify the same owner during refresh, but never authorize a write.
  const owner = read?.identity.ownerUserId ?? view.staleRead?.identity.ownerUserId;
  const confirmedOwner = read?.identity.ownerUserId;
  const lastVerifiedOwner = useRef(confirmedOwner);
  useEffect(() => {
    // Re-verifying the same session briefly withdraws identity. Hide its notice during that gap, then restore it;
    // only a different verified owner clears it. Otherwise the reread after a refused confirmation eats its explanation.
    if (confirmedOwner && lastVerifiedOwner.current !== confirmedOwner) {
      lastVerifiedOwner.current = confirmedOwner;
      setSnapshot(null);
      setNotice(null);
    }
  }, [confirmedOwner]);
  const current = (expectedOwner: string) =>
    alive.current &&
    latest.current.read?.identity.ownerUserId === expectedOwner &&
    latest.current.view.resultGeneration === latest.current.view.readsStarted();
  const withdraw = () => {
    if (!alive.current) return;
    setSnapshot(null);
    setNotice('changed');
  };
  useEffect(() => {
    if (
      snapshot &&
      !running.current &&
      (read?.identity.ownerUserId !== snapshot.ownerUserId || view.resultGeneration !== view.readsStarted())
    ) {
      setSnapshot(null);
      setNotice('changed');
    }
  }, [snapshot, read, view]);
  const prepare = async (period: MentionIgnorePeriod) => {
    if (!owner || personal.batchRefusal !== null || running.current) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const preview = await readPersonalMentionPreview(owner, period);
      if (!current(owner)) {
        withdraw();
        return;
      }
      if (preview.personalView.preferenceRevision !== latest.current.read?.personalView?.preferenceRevision) {
        setNotice('changed');
        view.refetch();
        return;
      }
      if (!preview.requests.length) setNotice('empty');
      else setSnapshot(preview);
    } catch {
      if (alive.current) setNotice(current(owner) ? 'unavailable' : 'changed');
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!snapshot || running.current) return;
    if (!current(snapshot.ownerUserId) || personal.batchRefusal !== null) {
      withdraw();
      return;
    }
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await readPersonalMentionPreview(snapshot.ownerUserId, snapshot.period);
      if (!current(snapshot.ownerUserId)) {
        withdraw();
        return;
      }
      if (personalMentionPreviewKey(fresh) !== personalMentionPreviewKey(snapshot)) {
        setNotice('changed');
        view.refetch();
        return;
      }
      const coordinates = fresh.requests
        .map((request) => request.preferenceCoordinate)
        .filter((coordinate): coordinate is UnifiedAttentionPreferenceCoordinate => coordinate.kind === 'mailbox');
      await latest.current.personal.ignoreBatch(coordinates, fresh.ownerUserId, fresh.personalView.preferenceRevision);
      // The writer exposes the actual failure (CAS conflict or unavailable); do not relabel every failure as a changed item.
    } catch {
      if (alive.current) setNotice(current(snapshot.ownerUserId) ? 'unavailable' : 'changed');
    } finally {
      setSnapshot(null);
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return {
    snapshot: snapshot?.ownerUserId === owner ? snapshot : null,
    busy,
    notice: owner && owner === lastVerifiedOwner.current ? notice : null,
    prepare,
    confirm,
    cancel: () => {
      if (!running.current) setSnapshot(null);
    },
  };
}
