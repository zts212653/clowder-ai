'use client';

/**
 * F157 Phase B: Individual title card — shows locked/unlocked state,
 * conditions, and rarity glow.
 */

import type { GrowthDimension, TitleDefinition, TitleRarity, UnlockedTitle } from '@cat-cafe/shared';
import { DIMENSION_LABELS } from '@cat-cafe/shared';

const RARITY_COLORS: Record<TitleRarity, { bg: string; border: string; text: string }> = {
  common: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600' },
  rare: { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700' },
  epic: { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700' },
  legendary: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700' },
};

const RARITY_LABELS: Record<TitleRarity, string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

interface Props {
  definition: TitleDefinition;
  unlock?: UnlockedTitle;
  /** Current dimension levels for progress display */
  dimensionLevels?: Partial<Record<GrowthDimension, number>>;
  overallLevel?: number;
  totalXp?: number;
}

export function TitleCard({ definition, unlock, dimensionLevels, overallLevel, totalXp }: Props) {
  const isUnlocked = !!unlock;
  const style = RARITY_COLORS[definition.rarity];

  return (
    <div
      className={`rounded-lg border p-3 transition-all ${
        isUnlocked ? `${style.bg} ${style.border}` : 'border-cafe-surface-elevated bg-cafe-surface opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-sm font-semibold ${isUnlocked ? style.text : 'text-cafe-muted'}`}>
              {isUnlocked ? definition.label.zh : '???'}
            </span>
            <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${style.text} ${style.bg}`}>
              {RARITY_LABELS[definition.rarity]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-cafe-muted">
            {isUnlocked ? definition.description.zh : definition.description.zh}
          </p>
        </div>
        {isUnlocked ? (
          <span className="text-lg">&#9733;</span>
        ) : (
          <span className="text-lg text-cafe-muted">&#9734;</span>
        )}
      </div>

      {/* Condition progress */}
      <div className="mt-2 space-y-1">
        {definition.conditions.map((cond, i) => {
          let label = '';
          let current = 0;
          let target = 0;

          if (cond.type === 'dimension_level') {
            const dimLabel = DIMENSION_LABELS[cond.dimension]?.zh ?? cond.dimension;
            label = `${dimLabel} Lv.${cond.minLevel}`;
            current = dimensionLevels?.[cond.dimension] ?? 0;
            target = cond.minLevel;
          } else if (cond.type === 'overall_level') {
            label = `总历练 Lv.${cond.minLevel}`;
            current = overallLevel ?? 0;
            target = cond.minLevel;
          } else if (cond.type === 'total_xp') {
            label = `总足迹点 ${cond.minXp}`;
            current = totalXp ?? 0;
            target = cond.minXp;
          }

          const met = current >= target;
          const progress = target > 0 ? Math.min(current / target, 1) : 0;

          return (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className={met ? 'text-green-600' : 'text-cafe-muted'}>{met ? '✓' : '○'}</span>
              <span className="flex-1 text-cafe-secondary">{label}</span>
              {!met && (
                <div className="flex items-center gap-1">
                  <div className="h-1 w-12 rounded-full bg-cafe-surface-elevated">
                    <div
                      className="h-full rounded-full bg-cafe-secondary transition-all"
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                  <span className="text-cafe-muted">
                    {current}/{target}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isUnlocked && unlock && (
        <div className="mt-1.5 text-[10px] text-cafe-muted">
          {new Date(unlock.unlockedAt).toLocaleDateString('zh-CN')} 解锁
        </div>
      )}
    </div>
  );
}
