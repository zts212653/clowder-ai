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
    <span
      className="text-[11px] font-medium"
      style={{ color: 'var(--cafe-text-muted)', fontFamily: 'Plus Jakarta Sans, sans-serif' }}
    >
      {label}
    </span>
  );
}

export function CatHeroCard({ cat, unit }: { cat: RankedCat; unit: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl p-5" style={{ background: 'var(--console-pill-bg)' }}>
      <span className="text-[28px]">{MEDAL[cat.rank - 1] ?? `#${cat.rank}`}</span>
      <CatAvatar catId={cat.catId} size={72} />
      <span
        className="text-lg font-medium"
        style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-text-primary)' }}
      >
        {cat.displayName}
      </span>
      <CatTag catId={cat.catId} />
      <span
        className="text-4xl font-medium tracking-tight"
        style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-accent)' }}
      >
        {cat.count}
      </span>
      <span className="text-[11px] font-medium" style={{ color: 'var(--cafe-text-muted)' }}>
        {unit}
      </span>
    </div>
  );
}

export function WorkMetric({ cat, label }: { cat: RankedCat | undefined; label: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl p-5" style={{ background: 'var(--console-pill-bg)' }}>
      <span
        className="text-4xl font-medium tracking-tight"
        style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-text-primary)' }}
      >
        {cat?.count ?? 0}
      </span>
      <span
        className="text-xs font-medium"
        style={{ color: 'var(--cafe-text-muted)', fontFamily: 'Plus Jakarta Sans, sans-serif' }}
      >
        {label}
      </span>
      {cat && (
        <span
          className="inline-flex self-start rounded-md px-2.5 py-1 text-[11px] font-semibold"
          style={{
            background: 'rgba(139,111,71,0.08)',
            color: 'var(--cafe-accent)',
            fontFamily: 'Plus Jakarta Sans, sans-serif',
          }}
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
      <p className="text-sm" style={{ color: 'var(--cafe-text-muted)' }}>
        暂无数据
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.slice(0, 5).map((cat) => (
        <li key={cat.catId} className="flex items-center gap-2">
          <span className="text-sm">{MEDAL[cat.rank - 1] ?? `#${cat.rank}`}</span>
          <CatAvatar catId={cat.catId} size={24} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--cafe-text-primary)' }}>
            {cat.displayName}
          </span>
          <span className="text-[11px] ml-auto" style={{ color: 'var(--cafe-text-muted)' }}>
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
      <p className="text-sm" style={{ color: 'var(--cafe-text-muted)' }}>
        暂无数据
      </p>
    );
  return (
    <ul className="space-y-2">
      {items.slice(0, 5).map((cat) => (
        <li key={cat.catId} className="flex items-center gap-2">
          <span className="text-sm">{MEDAL[cat.rank - 1] ?? `#${cat.rank}`}</span>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--cafe-text-primary)' }}>
            {cat.displayName}
          </span>
          <span className="text-[11px] ml-auto" style={{ color: 'var(--cafe-text-muted)' }}>
            连续 {cat.currentStreak} 天 (最长 {cat.maxStreak})
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl p-6 flex flex-col gap-4" style={{ background: 'var(--console-card-bg)' }}>
      <h3 className="text-xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: 'var(--cafe-text-primary)' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}
