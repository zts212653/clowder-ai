'use client';

import type { AchievementRarity, UnlockedAchievement } from '@cat-cafe/shared';

const RARITY_STYLES: Record<AchievementRarity, { bg: string; border: string; text: string; glow: string }> = {
  common: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-600', glow: '' },
  rare: { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700', glow: '' },
  epic: { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700', glow: 'shadow-purple-200/50' },
  legendary: { bg: 'bg-amber-50', border: 'border-amber-400', text: 'text-amber-700', glow: 'shadow-amber-200/50' },
};

const RARITY_LABELS: Record<AchievementRarity, string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

const CATEGORY_LABELS: Record<string, string> = {
  individual: '个人',
  team: '团队',
  milestone: '里程碑',
  hidden: '隐藏',
};

interface Props {
  definition: {
    id: string;
    label: { zh: string; en: string };
    description: { zh: string; en: string };
    category: string;
    rarity: AchievementRarity;
    icon?: string;
  };
  unlock: UnlockedAchievement | null;
}

export function AchievementCard({ definition, unlock }: Props) {
  const isUnlocked = !!unlock;
  const style = RARITY_STYLES[definition.rarity];
  const isHidden = definition.category === 'hidden';

  return (
    <div
      className={`rounded-lg border p-3 transition-all ${
        isUnlocked
          ? `${style.bg} ${style.border} ${style.glow ? `shadow-md ${style.glow}` : ''}`
          : 'border-cafe-surface-elevated bg-cafe-surface opacity-50'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-lg">{isUnlocked ? '\u2B50' : '\u2606'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-sm font-semibold ${isUnlocked ? style.text : 'text-cafe-muted'}`}>
              {isUnlocked || !isHidden ? definition.label.zh : '???'}
            </span>
            <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${style.text} ${style.bg}`}>
              {RARITY_LABELS[definition.rarity]}
            </span>
            <span className="rounded px-1 py-0.5 text-[10px] text-cafe-muted">
              {CATEGORY_LABELS[definition.category] ?? definition.category}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-cafe-muted">
            {isUnlocked || !isHidden ? definition.description.zh : '??????'}
          </p>
          {isUnlocked && unlock && (
            <p className="mt-1 text-[10px] text-cafe-muted">
              {new Date(unlock.unlockedAt).toLocaleDateString('zh-CN')} 解锁
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
