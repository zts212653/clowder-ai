'use client';

import type { RankedCat, StreakCat } from '@cat-cafe/shared';
import { type ReactNode } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { CatAvatar } from './CatAvatar';

const MEDAL = ['🥇', '🥈', '🥉'];

function CatTag({ catId }: { catId: string }) {
  const { getCatById } = useCatData();
  const cat = getCatById(catId);
  const family = cat?.breedDisplayName ?? cat?.displayName;
  const detail = cat?.variantLabel ?? cat?.nickname ?? cat?.id;
  const label = family && detail && family !== detail ? `${family} · ${detail}` : (family ?? detail ?? catId);

  return (
    <span className="text-xs font-medium" style={{ color: '#8E8E93', fontFamily: 'Plus Jakarta Sans, sans-serif' }}>
      {label}
    </span>
  );
}

export function CatHeroCard({ cat, unit }: { cat: RankedCat; unit: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl p-5" style={{ background: '#F4EFE7' }}>
      <span className="text-3xl">{MEDAL[cat.rank - 1] ?? `#${cat.rank}`}</span>
      <CatAvatar catId={cat.catId} size={72} />
      <span className="text-lg font-medium" style={{ fontFamily: 'Fraunces, serif', color: '#2D2D2D' }}>
        {cat.displayName}
      </span>
      <CatTag catId={cat.catId} />
      <span className="text-4xl font-medium tracking-tight" style={{ fontFamily: 'Fraunces, serif', color: '#8B6F47' }}>
        {cat.count}
      </span>
      <span className="text-xs font-medium" style={{ color: '#8E8E93' }}>
        {unit}
      </span>
    </div>
  );
}

export function WorkMetric({ cat, label }: { cat: RankedCat | undefined; label: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl p-5" style={{ background: '#F4EFE7' }}>
      <span className="text-4xl font-medium tracking-tight" style={{ fontFamily: 'Fraunces, serif', color: '#2D2D2D' }}>
        {cat?.count ?? 0}
      </span>
      <span className="text-xs font-medium" style={{ color: '#8E8E93', fontFamily: 'Plus Jakarta Sans, sans-serif' }}>
        {label}
      </span>
      {cat && (
        <span
          className="inline-flex self-start rounded-md px-2.5 py-1 text-xs font-semibold"
          style={{ background: 'rgba(139,111,71,0.08)', color: '#8B6F47', fontFamily: 'Plus Jakarta Sans, sans-serif' }}
        >
          🏅 {cat.displayName}
        </span>
      )}
    </div>
  );
}

export function MiniRanked({ items, unit }: { items: RankedCat[]; unit: string }) {
  if (items.length === 0)
    return (
      <p className="text-sm" style={{ color: '#8E8E93' }}>
        暂无数据
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.slice(0, 5).map((cat) => (
        <li key={cat.catId} className="flex items-center gap-2">
          <span className="text-sm">{MEDAL[cat.rank - 1] ?? `#${cat.rank}`}</span>
          <CatAvatar catId={cat.catId} size={24} />
          <span className="text-sm font-semibold" style={{ color: '#2D2D2D' }}>
            {cat.displayName}
          </span>
          <span className="text-xs ml-auto" style={{ color: '#8E8E93' }}>
            {cat.count} {unit}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StreakRanked({ items }: { items: StreakCat[] }) {
  if (items.length === 0)
    return (
      <p className="text-sm" style={{ color: '#8E8E93' }}>
        暂无数据
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.slice(0, 5).map((cat) => (
        <li key={cat.catId} className="flex items-center gap-2">
          <span className="text-sm">{MEDAL[cat.rank - 1] ?? `#${cat.rank}`}</span>
          <span className="text-sm font-semibold" style={{ color: '#2D2D2D' }}>
            {cat.displayName}
          </span>
          <span className="text-xs ml-auto" style={{ color: '#8E8E93' }}>
            连续 {cat.currentStreak} 天 (最长 {cat.maxStreak})
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl p-6 flex flex-col gap-4" style={{ background: '#FFFDF8' }}>
      <h3 className="text-xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: '#2D2D2D' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}
