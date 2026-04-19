'use client';

import type { CatGrowthProfile, GrowthDimension } from '@cat-cafe/shared';
import { useCatData } from '@/hooks/useCatData';
import { GrowthRadarChart } from './GrowthRadarChart';

const DIM_LABELS: Record<GrowthDimension, string> = {
  architecture: '架构力',
  review: '审查力',
  aesthetics: '审美力',
  execution: '执行力',
  collaboration: '协作力',
  insight: '洞察力',
};

const DIMENSIONS: GrowthDimension[] = ['architecture', 'review', 'aesthetics', 'execution', 'collaboration', 'insight'];

interface Props {
  profile: CatGrowthProfile;
  onClick?: () => void;
}

/** Compact summary card — click to open detail modal. */
export function CatProfileCard({ profile, onClick }: Props) {
  const { getCatById } = useCatData();
  const catData = getCatById(profile.catId);
  const primaryColor = catData?.color?.primary ?? '#9B7EBD';
  const { attributes } = profile;
  const { stats, overallLevel, totalXp } = attributes;

  // Find top 2 dimensions by XP
  const ranked = DIMENSIONS.map((d) => ({ dim: d, xp: stats[d]?.xp ?? 0 }))
    .filter((d) => d.xp > 0)
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 2);

  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl bg-cafe-surface p-4 text-left shadow-[0_1px_8px_rgba(0,0,0,0.03)] transition-all hover:shadow-[0_2px_16px_rgba(0,0,0,0.07)] active:scale-[0.98]"
      style={{ borderTop: `3px solid ${primaryColor}` }}
    >
      {/* Header */}
      <div className="mb-3 flex items-center gap-3">
        {catData?.avatar ? (
          <img src={catData.avatar} alt="" className="h-9 w-9 rounded-full" />
        ) : (
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-white"
            style={{ backgroundColor: primaryColor }}
          >
            {profile.displayName.charAt(0)}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-cafe">{profile.nickname ?? profile.displayName}</span>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: primaryColor }}
            >
              {/* Lv. maps to 历练 (Seasoning) */}
              Lv.{overallLevel}
            </span>
          </div>
          <span className="text-[11px] text-cafe-muted">
            {profile.currentTitle?.label.zh ?? profile.displayName}
            {' · '}
            {totalXp.toLocaleString()} 足迹点
          </span>
        </div>
      </div>

      {/* Compact radar */}
      <div className="flex justify-center">
        <GrowthRadarChart stats={stats} size={150} color={primaryColor} />
      </div>

      {/* Top dimensions highlight */}
      {ranked.length > 0 && (
        <div className="mt-2 flex items-center justify-center gap-3">
          {ranked.map(({ dim, xp }) => (
            <span key={dim} className="text-[11px] text-cafe-secondary">
              {/* Lv. maps to 历练 (Seasoning) */}
              {DIM_LABELS[dim]} Lv.{stats[dim]?.level ?? 0}
              <span className="ml-0.5 text-cafe-muted">({xp})</span>
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
