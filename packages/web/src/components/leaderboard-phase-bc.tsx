'use client';

import type { Achievement, CvoLevel, GameStats, SillyCatEntry } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { CatAvatar } from './CatAvatar';
import { CafeIcon } from './rich/CafeIcons';

function CatName({ catId }: { catId: string }) {
  const resolveCatName = useCatNameResolver();
  return <>{resolveCatName(catId)}</>;
}

/** Phase B: Silly cats — 翻车现场 */
export function SillyCatsList({ entries }: { entries: SillyCatEntry[] }) {
  if (entries.length === 0)
    return (
      <p className="text-sm" style={{ color: 'var(--cafe-text-muted)' }}>
        暂无翻车记录
      </p>
    );
  return (
    <ul className="space-y-2">
      {entries.slice(0, 5).map((e) => (
        <li key={e.catId} className="flex items-center gap-2">
          <CatAvatar catId={e.catId} size={24} />
          <span className="text-compact font-semibold" style={{ color: 'var(--cafe-text)' }}>
            <CatName catId={e.catId} />
          </span>
          <span className="text-label ml-auto font-medium" style={{ color: 'var(--cafe-accent)' }}>
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
        <span className="text-3xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-accent)' }}>
          {stats.catKill.wins}
        </span>
        <span className="text-label" style={{ color: 'var(--cafe-text-muted)' }}>
          猫猫杀 胜场
        </span>
        {stats.catKill.topCat && (
          <span className="text-label font-semibold" style={{ color: 'var(--cafe-accent)' }}>
            <span className="inline-flex items-center gap-1">
              <CafeIcon name="trophy" className="w-3 h-3" />
              MVP: <CatName catId={stats.catKill.topCat.catId} />
            </span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-3xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-accent)' }}>
          {stats.whoSpy.shameCount}
        </span>
        <span className="text-label" style={{ color: 'var(--cafe-text-muted)' }}>
          谁是卧底 社死次数
        </span>
        {stats.whoSpy.shameCat && (
          <span className="text-label font-semibold" style={{ color: 'var(--cafe-accent)' }}>
            <span className="inline-flex items-center gap-1">
              <CafeIcon name="cross" className="w-3 h-3" />
              社死王: <CatName catId={stats.whoSpy.shameCat.catId} />
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
      <p className="text-sm" style={{ color: 'var(--cafe-text-muted)' }}>
        尚未解锁成就
      </p>
    );
  return (
    <div className="flex flex-wrap gap-3">
      {achievements.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: 'color-mix(in srgb, var(--cafe-accent) 8%, transparent)' }}
          title={a.description}
        >
          <span className="text-conn-amber-text" aria-hidden="true">
            {a.icon ? (
              <CafeIcon name={a.icon} className="w-4 h-4" />
            ) : a.emoji ? (
              a.emoji
            ) : (
              <CafeIcon name="star" className="w-4 h-4" />
            )}
          </span>
          <span className="text-xs font-semibold" style={{ color: 'var(--cafe-accent)' }}>
            {a.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Phase C: operator level card */
export function CvoLevelCard({ level }: { level: CvoLevel }) {
  const pct = Math.round(level.progress * 100);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-accent)' }}>
          Lv.{level.level}
        </span>
        <span className="text-sm font-semibold" style={{ color: 'var(--cafe-text)' }}>
          {level.title}
        </span>
      </div>
      <p className="text-label" style={{ color: 'var(--cafe-text-muted)' }}>
        {level.description}
      </p>
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ background: 'color-mix(in srgb, var(--cafe-accent) 10%, transparent)' }}
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--cafe-accent)' }} />
      </div>
      {level.nextTitle && (
        <span className="text-label" style={{ color: 'var(--cafe-text-muted)' }}>
          距离「{level.nextTitle}」还需 {level.needed} 个 operator 成就
        </span>
      )}
    </div>
  );
}
