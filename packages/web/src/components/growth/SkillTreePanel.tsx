'use client';

/**
 * F157 Phase B AC-B3: Skill tree panel — shows title (珍贵瞬间/Moments) unlock paths
 * and bond relationships for a single cat.
 */

import type {
  BondLevel,
  CatBond,
  CatGrowthProfile,
  GrowthDimension,
  TitleRarity,
  UnlockedTitle,
} from '@cat-cafe/shared';
import { TITLE_DEFINITIONS } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { BondDisplay } from './BondDisplay';
import { TitleCard } from './TitleCard';

const RARITY_ORDER: TitleRarity[] = ['common', 'rare', 'epic', 'legendary'];

const RARITY_SECTION_LABELS: Record<TitleRarity, string> = {
  common: '普通称号',
  rare: '稀有称号',
  epic: '史诗称号',
  legendary: '传说称号',
};

interface Props {
  profile: CatGrowthProfile;
}

export function SkillTreePanel({ profile }: Props) {
  const [unlocked, setUnlocked] = useState<UnlockedTitle[]>([]);
  const [bonds, setBonds] = useState<(CatBond & { level: BondLevel })[]>([]);
  const [loading, setLoading] = useState(true);
  const [titleError, setTitleError] = useState(false);
  const [bondError, setBondError] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setTitleError(false);
    setBondError(false);
    const [titlesRes, bondsRes] = await Promise.allSettled([
      apiFetch(`/api/journey/${profile.catId}/titles`),
      apiFetch(`/api/journey/${profile.catId}/bonds`),
    ]);
    if (titlesRes.status === 'fulfilled' && titlesRes.value.ok) {
      const data = (await titlesRes.value.json()) as { unlocked: UnlockedTitle[] };
      setUnlocked(data.unlocked);
    } else {
      setTitleError(true);
    }
    if (bondsRes.status === 'fulfilled' && bondsRes.value.ok) {
      const data = (await bondsRes.value.json()) as { bonds: (CatBond & { level: BondLevel })[] };
      setBonds(data.bonds);
    } else {
      setBondError(true);
    }
    setLoading(false);
  }, [profile.catId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const { stats, overallLevel, totalXp } = profile.attributes;

  // Build dimension level map for condition display
  const dimensionLevels: Partial<Record<GrowthDimension, number>> = {};
  for (const [dim, stat] of Object.entries(stats)) {
    dimensionLevels[dim as GrowthDimension] = stat.level;
  }

  // Group titles by rarity
  const grouped = new Map<TitleRarity, typeof TITLE_DEFINITIONS>();
  for (const rarity of RARITY_ORDER) {
    grouped.set(
      rarity,
      TITLE_DEFINITIONS.filter((d) => d.rarity === rarity),
    );
  }

  if (loading) {
    return <div className="py-6 text-center text-xs text-cafe-muted">加载中...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Title progression */}
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-cafe">称号路径</h3>
          {!titleError && (
            <span className="text-xs text-cafe-muted">
              已解锁 {unlocked.length} / {TITLE_DEFINITIONS.length}
            </span>
          )}
        </div>
        {titleError ? (
          <div className="py-2 text-center text-xs text-red-400">称号数据加载失败，请稍后重试</div>
        ) : (
          <div className="space-y-4">
            {RARITY_ORDER.map((rarity) => {
              const defs = grouped.get(rarity);
              if (!defs || defs.length === 0) return null;
              return (
                <div key={rarity}>
                  <h4 className="mb-2 text-xs font-medium text-cafe-secondary">{RARITY_SECTION_LABELS[rarity]}</h4>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {defs.map((def) => (
                      <TitleCard
                        key={def.id}
                        definition={def}
                        unlock={unlocked.find((u) => u.titleId === def.id)}
                        dimensionLevels={dimensionLevels}
                        overallLevel={overallLevel}
                        totalXp={totalXp}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bond relationships */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-cafe">羁绊关系</h3>
        {bondError ? (
          <div className="py-2 text-center text-xs text-red-400">羁绊数据加载失败，请稍后重试</div>
        ) : (
          <BondDisplay catId={profile.catId} bonds={bonds} />
        )}
      </div>
    </div>
  );
}
