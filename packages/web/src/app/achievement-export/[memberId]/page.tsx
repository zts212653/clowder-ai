'use client';

/**
 * F157 AC-C4: Achievement Wall Export Page
 *
 * Standalone page rendered for Puppeteer screenshot.
 * ImageExporter navigates here, waits for data-export-ready="true", then captures.
 * Designed for tight 480px viewport — card fills width.
 *
 * URL: /achievement-export/:memberId?export=true&userId=...
 */

import type { AchievementRarity, UnlockedAchievement } from '@cat-cafe/shared';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface AchievementWallEntry {
  id: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  category: string;
  rarity: AchievementRarity;
  unlocked: UnlockedAchievement | null;
}

interface WallResponse {
  memberId: string;
  achievements: AchievementWallEntry[];
  totalUnlocked: number;
  totalDefined: number;
}

const RARITY_STYLES: Record<AchievementRarity, { bg: string; border: string; text: string }> = {
  common: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600' },
  rare: { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700' },
  epic: { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700' },
  legendary: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700' },
};

const RARITY_LABELS: Record<AchievementRarity, string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

export default function AchievementExportPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const [wall, setWall] = useState<WallResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!memberId) return;
    apiFetch(`/api/achievements/${memberId}/wall`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `Failed to load (${res.status})`);
          return;
        }
        setWall((await res.json()) as WallResponse);
      })
      .catch(() => setError('Network error'));
  }, [memberId]);

  const ready = wall !== null;
  const unlocked = wall?.achievements.filter((a) => a.unlocked) ?? [];

  return (
    <div className="bg-cafe-surface-elevated p-5" {...(ready ? { 'data-export-ready': 'true' } : {})}>
      {error ? (
        <div className="text-sm text-red-500">{error}</div>
      ) : wall ? (
        <>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-base font-bold text-cafe">成就墙</h2>
            <span className="text-xs text-cafe-muted">
              已解锁 {wall.totalUnlocked} / {wall.totalDefined}
            </span>
          </div>
          <div className="space-y-2">
            {unlocked.map((entry) => {
              const style = RARITY_STYLES[entry.rarity];
              return (
                <div key={entry.id} className={`rounded-lg border p-3 ${style.bg} ${style.border}`}>
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-lg">{'\u2B50'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-semibold ${style.text}`}>{entry.label.zh}</span>
                        <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${style.text} ${style.bg}`}>
                          {RARITY_LABELS[entry.rarity]}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-cafe-muted">{entry.description.zh}</p>
                      {entry.unlocked && (
                        <p className="mt-1 text-[10px] text-cafe-muted">
                          {new Date(entry.unlocked.unlockedAt).toLocaleDateString('zh-CN')} 解锁
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 text-center text-[10px] text-cafe-muted">Clowder AI · Achievement Wall</div>
        </>
      ) : (
        <div className="text-sm text-cafe-muted">Loading...</div>
      )}
    </div>
  );
}
