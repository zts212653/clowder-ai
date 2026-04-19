'use client';

/**
 * F157 Phase C AC-C3: Achievement wall — shows all achievements with unlock status.
 * Fetches data per member from /api/achievements/:memberId/wall.
 */

import type { AchievementRarity, UnlockedAchievement } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { DownloadIcon } from '@/components/icons/DownloadIcon';
import { apiFetch } from '@/utils/api-client';
import { AchievementCard } from './AchievementCard';

interface AchievementWallEntry {
  id: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  category: string;
  rarity: AchievementRarity;
  icon?: string;
  unlocked: UnlockedAchievement | null;
}

interface WallResponse {
  memberId: string;
  achievements: AchievementWallEntry[];
  totalUnlocked: number;
  totalDefined: number;
}

const CATEGORY_ORDER = ['individual', 'team', 'milestone', 'hidden'];
const CATEGORY_LABELS: Record<string, string> = {
  individual: '个人瞬间',
  team: '团队瞬间',
  milestone: '里程碑',
  hidden: '隐藏瞬间',
};

interface Props {
  memberId: string;
}

export function AchievementWall({ memberId }: Props) {
  const [wall, setWall] = useState<WallResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchWall = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch(`/api/achievements/${memberId}/wall`);
      if (res.ok) {
        setWall((await res.json()) as WallResponse);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  useEffect(() => {
    fetchWall();
  }, [fetchWall]);

  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await apiFetch(`/api/achievements/${memberId}/export-image`, { method: 'POST' });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `achievements-${memberId}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* silent — export is best-effort */
    } finally {
      setExporting(false);
    }
  }, [memberId]);

  if (loading) return <div className="py-4 text-center text-xs text-cafe-muted">加载中...</div>;
  if (error) return <div className="py-4 text-center text-xs text-red-400">珍贵瞬间数据加载失败</div>;
  if (!wall) return null;

  // Group by category
  const grouped = new Map<string, AchievementWallEntry[]>();
  for (const cat of CATEGORY_ORDER) {
    grouped.set(
      cat,
      wall.achievements.filter((a) => a.category === cat),
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-cafe">珍贵瞬间</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-cafe-muted">
            已解锁 {wall.totalUnlocked} / {wall.totalDefined}
          </span>
          {wall.totalUnlocked > 0 && (
            <button
              onClick={handleExport}
              disabled={exporting}
              className="rounded p-1 transition-colors hover:bg-cafe-surface-elevated disabled:opacity-50"
              title="导出珍贵瞬间"
            >
              <DownloadIcon className="h-3.5 w-3.5 text-cafe-muted" />
            </button>
          )}
        </div>
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const items = grouped.get(cat);
        if (!items || items.length === 0) return null;
        return (
          <div key={cat}>
            <h4 className="mb-2 text-xs font-medium text-cafe-secondary">{CATEGORY_LABELS[cat] ?? cat}</h4>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((entry) => (
                <AchievementCard key={entry.id} definition={entry} unlock={entry.unlocked} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
