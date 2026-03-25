'use client';

import type { LeaderboardRange, LeaderboardStatsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CatHeroCard, MiniRanked, SectionCard, StreakRanked, WorkMetric } from './leaderboard-cards';
import { AchievementWall, CvoLevelCard, GameArena, SillyCatsList } from './leaderboard-phase-bc';

/* -- Design tokens from designs/f075-cat-leaderboard.pen (lzNOb) -- */
const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Fraunces:wght@500&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap';

const RANGE_OPTIONS: { value: LeaderboardRange; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

export function HubLeaderboardTab() {
  const [data, setData] = useState<LeaderboardStatsResponse | null>(null);
  const [range, setRange] = useState<LeaderboardRange>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async (r: LeaderboardRange) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leaderboard/stats?range=${r}`);
      if (res.ok) setData((await res.json()) as LeaderboardStatsResponse);
      else setError('排行榜加载失败');
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats(range);
  }, [range, fetchStats]);

  const top3 = data?.mentions.favoriteCat.slice(0, 3) ?? [];

  return (
    <div
      className="flex flex-col gap-6 p-6 rounded-xl overflow-y-auto"
      style={{ background: '#F4EFE7', fontFamily: 'Plus Jakarta Sans, sans-serif' }}
    >
      <link rel="stylesheet" href={FONTS_URL} />

      {/* Header + Range Filter */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-medium" style={{ fontFamily: 'Fraunces, serif', color: '#2D2D2D' }}>
          Cat Leaderboard
        </h2>
        <div className="flex gap-3">
          {RANGE_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.value}
              onClick={() => setRange(opt.value)}
              className="rounded-lg px-4 py-2.5 text-[13px] font-medium transition-colors"
              style={
                range === opt.value
                  ? { background: '#8B6F47', color: '#FFFFFF' }
                  : { background: 'transparent', color: '#8E8E93' }
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-sm rounded-lg px-3 py-2" style={{ color: '#D4845E', background: 'rgba(212,132,94,0.1)' }}>
          {error}
        </p>
      )}
      {loading && !data && (
        <p className="text-sm" style={{ color: '#8E8E93' }}>
          加载中...
        </p>
      )}

      {data && (
        <>
          {/* Hero — Most Beloved */}
          <SectionCard title="本周之星">
            <p className="text-[13px]" style={{ color: '#8E8E93' }}>
              Who is the most beloved feline?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {top3.map((cat) => (
                <CatHeroCard key={cat.catId} cat={cat} unit="times mentioned" />
              ))}
            </div>
          </SectionCard>

          {/* Work Stats — 搬砖排行 */}
          <SectionCard title="搬砖排行">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <WorkMetric cat={data.work.commits[0]} label="Commits" />
              <WorkMetric cat={data.work.reviews[0]} label="Reviews" />
              <WorkMetric cat={data.work.bugFixes[0]} label="Bug Fixes" />
            </div>
          </SectionCard>

          {/* Mention Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <SectionCard title="夜猫子">
              <MiniRanked items={data.mentions.nightOwl} unit="次深夜 @" />
            </SectionCard>
            <SectionCard title="话痨">
              <MiniRanked items={data.mentions.chatty} unit="条消息" />
            </SectionCard>
            <SectionCard title="连续签到">
              <StreakRanked items={data.mentions.streak} />
            </SectionCard>
            <SectionCard title="翻车现场">
              <SillyCatsList entries={data.silly?.entries ?? []} />
            </SectionCard>
          </div>

          {/* Phase B: Game Arena + Phase C: Achievements + CVO */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <SectionCard title="成就墙">
              <AchievementWall achievements={data.achievements ?? []} />
            </SectionCard>
            <SectionCard title="CVO 能力等级 🐾">
              {data.cvoLevel ? (
                <CvoLevelCard level={data.cvoLevel} />
              ) : (
                <p className="text-sm" style={{ color: '#8E8E93' }}>
                  暂无等级数据
                </p>
              )}
            </SectionCard>
            <SectionCard title="游戏竞技场">
              {data.games ? (
                <GameArena stats={data.games} />
              ) : (
                <p className="text-sm" style={{ color: '#8E8E93' }}>
                  暂无游戏数据
                </p>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}
