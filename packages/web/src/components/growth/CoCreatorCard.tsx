'use client';

/**
 * F157 AC-C6: Co-Creator (铲屎官) journey card — distinct from cat cards.
 * Shows human-specific metrics: contribution style, cat interaction overview.
 */

import type { CatGrowthProfile, GrowthDimension } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { GrowthRadarChart } from './GrowthRadarChart';

interface BondEntry {
  catA: string;
  catB: string;
  score: number;
  interactions: number;
  level: 'acquaintance' | 'partner' | 'soulmate';
}

const DIM_LABELS: Record<GrowthDimension, string> = {
  architecture: '架构力',
  review: '审查力',
  aesthetics: '审美力',
  execution: '执行力',
  collaboration: '协作力',
  insight: '洞察力',
};

const STYLE_PROFILES: { dims: GrowthDimension[]; label: string; icon: string }[] = [
  { dims: ['architecture', 'insight'], label: '战略型', icon: '\uD83C\uDFAF' },
  { dims: ['execution', 'review'], label: '实干型', icon: '\u26A1' },
  { dims: ['collaboration', 'aesthetics'], label: '赋能型', icon: '\uD83E\uDD1D' },
];

const BOND_LABELS: Record<string, string> = {
  acquaintance: '初识',
  partner: '搭档',
  soulmate: '心有灵犀',
};

interface Props {
  profile: CatGrowthProfile;
  onClick?: () => void;
}

export function CoCreatorCard({ profile, onClick }: Props) {
  const { cats } = useCatData();
  const { attributes } = profile;
  const { stats, overallLevel, totalXp } = attributes;
  const [bonds, setBonds] = useState<BondEntry[]>([]);

  useEffect(() => {
    apiFetch(`/api/journey/${profile.catId}/bonds`)
      .then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { bonds: BondEntry[] };
          setBonds(data.bonds);
        }
      })
      .catch(() => {});
  }, [profile.catId]);

  // Determine contribution style from top dimensions
  const dimRanked = (Object.keys(stats) as GrowthDimension[])
    .map((d) => ({ dim: d, xp: stats[d]?.xp ?? 0 }))
    .sort((a, b) => b.xp - a.xp);
  const topDims = new Set(dimRanked.slice(0, 2).map((d) => d.dim));

  const styleMatch = STYLE_PROFILES.find((s) => s.dims.some((d) => topDims.has(d)));
  const styleLabel = styleMatch?.label ?? '探索中';
  const styleIcon = styleMatch?.icon ?? '\uD83C\uDF1F';

  const getCatName = useCallback(
    (catId: string) => {
      const cat = cats.find((c) => c.id === catId);
      return cat?.nickname ?? cat?.displayName ?? catId;
    },
    [cats],
  );

  const getCatColor = useCallback(
    (catId: string) => {
      const cat = cats.find((c) => c.id === catId);
      return cat?.color?.primary ?? '#9B7EBD';
    },
    [cats],
  );

  // Top 3 bonds
  const topBonds = bonds.slice(0, 3);

  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl bg-cafe-surface p-5 text-left shadow-[0_1px_8px_rgba(0,0,0,0.03)] transition-all hover:shadow-[0_2px_16px_rgba(0,0,0,0.07)] active:scale-[0.99]"
      style={{ borderTop: '3px solid #D4A574' }}
    >
      <div className="flex gap-5">
        {/* Left: Identity + radar */}
        <div className="flex shrink-0 flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-100 to-orange-100 text-xl">
            {'\uD83D\uDC64'}
          </div>
          <div className="mt-3">
            <GrowthRadarChart stats={stats} size={140} color="#D4A574" />
          </div>
        </div>

        {/* Right: Metrics */}
        <div className="min-w-0 flex-1">
          {/* Name + level */}
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-cafe">铲屎官</span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              {/* Lv. maps to 历练 (Seasoning) */}
              Lv.{overallLevel}
            </span>
            <span className="rounded px-1.5 py-0.5 text-[10px] text-cafe-muted" style={{ background: '#FFF8F0' }}>
              {styleIcon} {styleLabel}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-cafe-muted">
            {profile.currentTitle?.label.zh ?? 'CVO'}
            {' · '}
            {totalXp.toLocaleString()} 足迹点
          </p>

          {/* Top dimensions */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {dimRanked
              .filter((d) => d.xp > 0)
              .slice(0, 3)
              .map(({ dim }) => {
                const s = stats[dim];
                if (!s) return null;
                return (
                  <span key={dim} className="text-[11px] text-cafe-secondary">
                    {DIM_LABELS[dim]}{' '}
                    <span className="font-medium" style={{ color: '#D4A574' }}>
                      Lv.{s.level}
                    </span>
                    <span className="ml-0.5 text-cafe-muted">({s.xp.toLocaleString()})</span>
                  </span>
                );
              })}
          </div>

          {/* Cat interaction bonds */}
          {topBonds.length > 0 && (
            <div className="mt-3 border-t border-cafe-surface-elevated pt-3">
              <p className="mb-1.5 text-[10px] font-medium text-cafe-muted">与猫猫互动</p>
              <div className="flex flex-wrap gap-2">
                {topBonds.map((bond) => {
                  const otherId = bond.catA === profile.catId ? bond.catB : bond.catA;
                  return (
                    <span
                      key={otherId}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                      style={{ backgroundColor: `${getCatColor(otherId)}15`, color: getCatColor(otherId) }}
                    >
                      <span className="font-medium">{getCatName(otherId)}</span>
                      <span className="opacity-70">{BOND_LABELS[bond.level] ?? bond.level}</span>
                      <span className="opacity-50">×{bond.interactions}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
