'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const PATH = '/api/config/live-projects';
function parseFolds(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || !('collapsed' in value)) throw new Error('Invalid fold preferences');
  const folds = value.collapsed;
  if (
    !folds ||
    typeof folds !== 'object' ||
    Array.isArray(folds) ||
    Object.values(folds).some((v) => typeof v !== 'boolean')
  )
    throw new Error('Invalid fold preferences');
  return folds as Record<string, boolean>;
}

/** Presentation state shares the server's no-expiry UserPreferences owner. */
export function useLiveProjectFolds(section: 'live' | 'waiting' | 'deployment' = 'live') {
  const path = section === 'live' ? PATH : `${PATH}?section=${section}`;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(false);
  const writing = useRef(false);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void apiFetch(path, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Fold preferences unavailable');
        const folds = parseFolds(await response.json());
        if (alive.current && !controller.signal.aborted) setCollapsed(folds);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [path]);

  const toggle = useCallback(
    async (projectPath: string) => {
      if (loading || writing.current) return;
      writing.current = true;
      setSaving(true);
      setError(false);
      const next = !(collapsed[projectPath] ?? section === 'deployment');
      setCollapsed((current) => ({ ...current, [projectPath]: next }));
      try {
        const response = await apiFetch(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath, collapsed: next }),
        });
        if (!response.ok || parseFolds(await response.json())[projectPath] !== next)
          throw new Error('Fold save failed');
      } catch {
        if (alive.current) {
          setCollapsed((current) => ({ ...current, [projectPath]: !next }));
          setError(true);
        }
      } finally {
        writing.current = false;
        if (alive.current) setSaving(false);
      }
    },
    [collapsed, loading, path, section],
  );
  return { collapsed, loading, saving, error, toggle };
}
