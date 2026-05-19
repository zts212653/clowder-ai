'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface FlagState {
  f200: { consumptionRerank: 'off' | 'shadow' | 'on' };
}

const MODE_LABELS: Record<string, { label: string; color: string }> = {
  off: { label: 'Off', color: 'bg-zinc-600' },
  shadow: { label: 'Shadow', color: 'bg-amber-600' },
  on: { label: 'On', color: 'bg-emerald-600' },
};

export function MemoryFlagPanel() {
  const [flags, setFlags] = useState<FlagState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchFlags = useCallback(async () => {
    try {
      const res = await apiFetch('/api/recall/flags');
      if (!res.ok) throw new Error(`Flags fetch failed: ${res.status}`);
      const data = (await res.json()) as FlagState;
      setFlags(data);
      setError(null);
    } catch {
      setError('Failed to fetch flags');
    }
  }, []);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-800/40 bg-red-950/20 p-4">
        <p className="text-sm text-conn-red-text">{error}</p>
      </div>
    );
  }

  if (!flags) return <p className="text-sm text-cafe-muted">Loading flags...</p>;

  const mode = flags.f200.consumptionRerank;
  const badge = MODE_LABELS[mode] ?? MODE_LABELS.off!;

  return (
    <div className="rounded-lg border border-cafe bg-cafe-card p-4" data-testid="memory-flag-panel">
      <h3 className="mb-3 text-sm font-medium text-cafe-text">Recall Feature Flags</h3>
      <div className="flex items-center gap-3">
        <span className="text-xs text-cafe-muted">F200 Consumption Rerank</span>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium text-white ${badge.color}`}
          data-testid="f200-rerank-badge"
        >
          {badge.label}
        </span>
      </div>
      {mode === 'shadow' && (
        <p className="mt-2 text-xs text-cafe-muted">
          Shadow mode: scoring computed and logged but ranking unchanged. Check shadowConsumedMRR in metrics.
        </p>
      )}
    </div>
  );
}
