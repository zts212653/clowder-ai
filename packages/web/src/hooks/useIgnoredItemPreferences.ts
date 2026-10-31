'use client';

import {
  type IgnoredItemCoordinate,
  type IgnoredItemSnapshot,
  ignoredItemKey,
  ignoredItemSnapshotSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const PATH = '/api/config/ignored-items';
const UPDATED = 'cat-cafe:ignored-item-preferences-updated';
type PreferenceError = 'unavailable' | 'conflict' | null;
type PreferenceChangeResult = { saved: true } | { saved: false; error: Exclude<PreferenceError, null> };

/** One owner-fenced read of the existing UserPreferences lane. No work/approval mutation or second store. */
export function useIgnoredItemPreferences(expectedOwnerUserId?: string, enabled = true) {
  const [snapshot, setSnapshot] = useState<IgnoredItemSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<PreferenceError>(null);
  const current = useRef<IgnoredItemSnapshot | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const writing = useRef(false);

  const accept = useCallback((value: IgnoredItemSnapshot | null) => {
    current.current = value;
    setSnapshot(value);
  }, []);

  const refetch = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    accept(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      const [session, response] = await Promise.all([
        apiFetch('/api/session'),
        apiFetch(PATH, undefined, { afterCurrentGet: true }),
      ]);
      if (!session.ok || !response.ok) throw new Error('Preferences unavailable');
      const principal: unknown = await session.json();
      const parsed = ignoredItemSnapshotSchema.parse(await response.json());
      const userId = principal && typeof principal === 'object' && 'userId' in principal ? principal.userId : null;
      if (parsed.ownerUserId !== userId || (expectedOwnerUserId && parsed.ownerUserId !== expectedOwnerUserId)) {
        throw new Error('Preference owner is unconfirmed');
      }
      if (alive.current && generation.current === requestGeneration) accept(parsed);
    } catch {
      if (alive.current && generation.current === requestGeneration) setError('unavailable');
    } finally {
      if (alive.current && generation.current === requestGeneration) setLoading(false);
    }
  }, [accept, expectedOwnerUserId, enabled]);

  useEffect(() => {
    alive.current = true;
    void refetch();
    const refresh = () => void refetch();
    window.addEventListener(UPDATED, refresh);
    return () => {
      alive.current = false;
      generation.current += 1;
      window.removeEventListener(UPDATED, refresh);
    };
  }, [refetch]);

  const changeWithResult = useCallback(
    async (ignore: IgnoredItemCoordinate[], restore: IgnoredItemCoordinate[]): Promise<PreferenceChangeResult> => {
      const before = current.current;
      if (!before || writing.current || loading) return { saved: false, error: 'conflict' };
      const requestGeneration = generation.current;
      writing.current = true;
      setSaving(true);
      setError(null);
      try {
        const response = await apiFetch(PATH, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedOwnerUserId: before.ownerUserId,
            expectedRevision: before.revision,
            ignore,
            restore,
          }),
        });
        const body: unknown = await response.json();
        if (
          !alive.current ||
          generation.current !== requestGeneration ||
          current.current?.ownerUserId !== before.ownerUserId
        )
          return { saved: false, error: 'conflict' };
        if (response.status === 409) {
          const server = body && typeof body === 'object' && 'snapshot' in body ? body.snapshot : null;
          const latest = ignoredItemSnapshotSchema.parse(server);
          if (latest.ownerUserId !== before.ownerUserId) throw new Error('Different owner');
          accept(latest);
          setError('conflict');
          return { saved: false, error: 'conflict' };
        }
        if (!response.ok) throw new Error('Preferences were not saved');
        const saved = ignoredItemSnapshotSchema.parse(body);
        if (saved.ownerUserId !== before.ownerUserId) throw new Error('Different owner');
        accept(saved);
        window.dispatchEvent(new Event(UPDATED));
        return { saved: true };
      } catch {
        if (alive.current && generation.current === requestGeneration) setError('unavailable');
        return { saved: false, error: 'unavailable' };
      } finally {
        writing.current = false;
        if (alive.current) setSaving(false);
      }
    },
    [accept, loading],
  );
  // Existing consumers retain their boolean contract; callers that refresh immediately use the terminal outcome.
  const change = useCallback(
    async (ignore: IgnoredItemCoordinate[], restore: IgnoredItemCoordinate[]) =>
      (await changeWithResult(ignore, restore)).saved,
    [changeWithResult],
  );

  const keys = new Set(snapshot?.entries.map((entry) => ignoredItemKey(entry.coordinate)) ?? []);
  return {
    snapshot,
    loading,
    saving,
    error,
    ready: snapshot !== null && !loading,
    refetch,
    change,
    changeWithResult,
    isIgnored: (coordinate: IgnoredItemCoordinate) => keys.has(ignoredItemKey(coordinate)),
  };
}
