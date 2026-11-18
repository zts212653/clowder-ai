'use client';
import type { WatcherPanelRound } from '@cat-cafe/shared';
import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

const STATUS: Record<WatcherPanelRound['members'][number]['status'], string> = {
  pending: '没轮到',
  running: '还在看',
  spoke: '说了',
  quiet: '没说',
  failed: '没跑成',
  interrupted: '中断了',
};

/**
 * F335: cats only ever read 「守望猫」. The person may look up who held which label in this round; the
 * ledger answers the owner session only.
 */
export function WatcherPanelReveal({
  roundId,
  getCatById,
}: {
  roundId: string;
  getCatById: (id: string) => CatData | undefined;
}) {
  const [round, setRound] = useState<WatcherPanelRound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (round)
    return (
      <p className="mt-2 text-xs text-cafe-muted" data-testid="watcher-panel-reveal">
        {[...round.members]
          .sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'))
          .map((member) => {
            const cat = getCatById(member.catId);
            return `${member.label}：${cat?.nickname ?? cat?.displayName ?? member.catId}（${STATUS[member.status]}）`;
          })
          .join(' · ')}
      </p>
    );
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        className="text-cafe-muted underline-offset-2 hover:underline disabled:opacity-60"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setError(null);
          apiFetch(`/api/watcher/panel/rounds/${encodeURIComponent(roundId)}`)
            .then(async (response) => {
              if (!response.ok) throw new Error('没查到这一轮');
              setRound(await response.json());
            })
            .catch((failure) => setError(failure instanceof Error ? failure.message : '没查到这一轮'))
            .finally(() => setLoading(false));
        }}
      >
        看是谁
      </button>
      {error && <span className="ml-2 text-red-600">{error}</span>}
    </div>
  );
}
