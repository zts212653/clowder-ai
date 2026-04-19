'use client';

/**
 * F157 Phase B AC-B2: Bond relationships between cats.
 * Shows bond level, score, and interaction count.
 */

import type { BondLevel, CatBond } from '@cat-cafe/shared';
import { useCatData } from '@/hooks/useCatData';

const BOND_LABELS: Record<BondLevel, { zh: string; icon: string; color: string }> = {
  acquaintance: { zh: '初识', icon: '🤝', color: 'text-gray-500' },
  partner: { zh: '搭档', icon: '💪', color: 'text-blue-600' },
  soulmate: { zh: '灵魂伙伴', icon: '💜', color: 'text-purple-600' },
};

interface Props {
  catId: string;
  bonds: (CatBond & { level: BondLevel })[];
}

export function BondDisplay({ catId, bonds }: Props) {
  const { getCatById } = useCatData();

  if (bonds.length === 0) {
    return (
      <div className="rounded-lg bg-cafe-surface p-4 text-center text-xs text-cafe-muted">
        暂无羁绊记录 — 多多协作就会产生羁绊
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {bonds.map((bond) => {
        const otherId = bond.catA === catId ? bond.catB : bond.catA;
        const otherCat = getCatById(otherId);
        const bondStyle = BOND_LABELS[bond.level];
        const primaryColor = otherCat?.color?.primary ?? '#9B7EBD';

        return (
          <div key={otherId} className="flex items-center gap-3 rounded-lg bg-cafe-surface px-3 py-2">
            {/* Cat avatar */}
            {otherCat?.avatar ? (
              <img src={otherCat.avatar} alt="" className="h-8 w-8 rounded-full" />
            ) : (
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold text-white"
                style={{ backgroundColor: primaryColor }}
              >
                {(otherCat?.displayName ?? otherId).charAt(0)}
              </div>
            )}

            {/* Name + bond level */}
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-cafe">
                  {otherCat?.nickname ?? otherCat?.displayName ?? otherId}
                </span>
                <span className={`text-xs font-medium ${bondStyle.color}`}>
                  {bondStyle.icon} {bondStyle.zh}
                </span>
              </div>
              <div className="text-[11px] text-cafe-muted">
                {bond.interactions} 次协作 · 羁绊值 {bond.score}
              </div>
            </div>

            {/* Bond strength bar */}
            <div className="w-16">
              <div className="h-1.5 rounded-full bg-cafe-surface-elevated">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min((bond.score / 50) * 100, 100)}%`,
                    backgroundColor: primaryColor,
                    opacity: 0.7,
                  }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
