'use client';

import type { Achievement, CvoLevel, GameStats, SillyCatEntry } from '@cat-cafe/shared';
import { CatAvatar } from './CatAvatar';
import { CafeIcon } from './rich/CafeIcons';

/** Phase B: Silly cats — 翻车现场 */
export function SillyCatsList({ entries }: { entries: SillyCatEntry[] }) {
  if (entries.length === 0)
    return (
      <p className="text-sm" style={{ color: '#8E8E93' }}>
        暂无翻车记录
      </p>
    );
  return (
    <ul className="space-y-2">
      {entries.slice(0, 5).map((e) => (
        <li key={e.catId} className="flex items-center gap-2">
          <CatAvatar catId={e.catId} size={24} />
          <span className="text-[13px] font-semibold" style={{ color: '#2D2D2D' }}>
            {e.displayName}
          </span>
          <span className="text-[11px] ml-auto font-medium" style={{ color: '#D4845E' }}>
            ×{e.count} {e.description}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Phase B: Game arena — 游戏竞技场 */
export function GameArena({ stats }: { stats: GameStats }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-3xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: '#8B6F47' }}>
          {stats.catKill.wins}
        </span>
        <span className="text-[11px]" style={{ color: '#8E8E93' }}>
          猫猫杀 胜场
        </span>
        {stats.catKill.topCat && (
          <span className="text-[11px] font-semibold" style={{ color: '#D4845E' }}>
            <span className="inline-flex items-center gap-1">
              <CafeIcon name="trophy" className="w-3 h-3" />
              MVP: {stats.catKill.topCat.displayName}
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-3xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: '#8B6F47' }}>
          {stats.whoSpy.shameCount}
        </span>
        <span className="text-[11px]" style={{ color: '#8E8E93' }}>
          谁是卧底 社死次数
        </span>
        {stats.whoSpy.shameCat && (
          <span className="text-[11px] font-semibold" style={{ color: '#D4845E' }}>
            <span className="inline-flex items-center gap-1">
              <CafeIcon name="cross" className="w-3 h-3" />
              社死王: {stats.whoSpy.shameCat.displayName}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Phase C: Achievement wall — 成就墙 */
export function AchievementWall({ achievements }: { achievements: Achievement[] }) {
  if (achievements.length === 0)
    return (
      <p className="text-sm" style={{ color: '#8E8E93' }}>
        尚未解锁成就
      </p>
    );
  return (
    <div className="flex flex-wrap gap-3">
      {achievements.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: 'rgba(139,111,71,0.08)' }}
          title={a.description}
        >
          <span className="text-amber-700" aria-hidden="true">
            {a.icon ? (
              <CafeIcon name={a.icon} className="w-4 h-4" />
            ) : a.emoji ? (
              a.emoji
            ) : (
              <CafeIcon name="star" className="w-4 h-4" />
            )}
          </span>
          <span className="text-[12px] font-semibold" style={{ color: '#8B6F47' }}>
            {a.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Phase C: CVO level card */
export function CvoLevelCard({ level }: { level: CvoLevel }) {
  const pct = Math.round(level.progress * 100);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: '#8B6F47' }}>
          Lv.{level.level}
        </span>
        <span className="text-sm font-semibold" style={{ color: '#2D2D2D' }}>
          {level.title}
        </span>
      </div>
      <p className="text-[11px]" style={{ color: '#8E8E93' }}>
        {level.description}
      </p>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(139,111,71,0.1)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: '#8B6F47' }} />
      </div>
      {level.nextTitle && (
        <span className="text-[11px]" style={{ color: '#8E8E93' }}>
          距离「{level.nextTitle}」还需 {level.needed} 个 CVO 成就
        </span>
      )}
    </div>
  );
}
