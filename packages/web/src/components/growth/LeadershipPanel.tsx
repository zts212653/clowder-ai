'use client';

/**
 * F157 AC-D5: Co-Creator Leadership Panel (铲屎官六维 Mission Control)
 *
 * Layout:
 *   Top    — Leadership Level + current title
 *   Middle — Six-dim radar chart + 4 live KPI cards
 *   Bottom — Leadership timeline (expandable)
 */

import type { LeadershipDimension, LeadershipProfile, LeadershipStat } from '@cat-cafe/shared';
import { LEADERSHIP_LIVE_DIMS } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { LeadershipRadarChart } from './LeadershipRadarChart';

const DIM_LABELS: Record<LeadershipDimension, string> = {
  coordination: '协调力',
  delegation: '授权力',
  exploration: '开拓力',
  guidance: '引导力',
  decision: '决策力',
  feedback: '反馈力',
};

const SOURCE_LABELS: Record<string, string> = {
  multi_mention_dispatch: '多猫调度',
  multi_mention_success: '调度成功',
  target_diversity: '目标多样',
  task_no_intervention: '自主完成',
  deep_collab_initiated: '深度协作',
  tool_category_breadth: '工具广度',
  new_skill_first_use: '新技能首用',
  feature_initiated: '发起新特性',
  one_shot_completion: '一次到位',
  low_clarification: '指令清晰',
  direction_confirmed: '快速拍板',
  feedback_applied: '反馈生效',
};

interface AuditEvent {
  dimension: LeadershipDimension;
  xp: number;
  source: string;
  timestamp: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function KpiCard({ stat }: { stat: LeadershipStat }) {
  const pct = stat.xpToNext > 0 ? Math.min(stat.xp / (stat.xp + stat.xpToNext), 1) : 1;
  return (
    <div className="rounded-lg bg-cafe-surface-elevated px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-cafe-secondary">{DIM_LABELS[stat.dimension]}</span>
        <span className="text-sm font-semibold" style={{ color: '#D4A574' }}>
          Lv.{stat.level}
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-cafe-surface">
        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: '#D4A574' }} />
      </div>
      <p className="mt-1 text-[10px] text-cafe-muted">{stat.xp.toLocaleString()} 足迹点</p>
    </div>
  );
}

export function LeadershipPanel() {
  const [profile, setProfile] = useState<LeadershipProfile | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineFetched, setTimelineFetched] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState(false);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/journey/leadership');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? '加载失败');
        return;
      }
      setProfile((await res.json()) as LeadershipProfile);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTimeline = useCallback(async () => {
    setTimelineLoading(true);
    setTimelineError(false);
    let ok = false;
    try {
      const res = await apiFetch('/api/journey/leadership/events?limit=30');
      if (res.ok) {
        const data = (await res.json()) as { events: AuditEvent[] };
        setEvents(data.events);
        ok = true;
      } else {
        setTimelineError(true);
      }
    } catch {
      setTimelineError(true);
    } finally {
      setTimelineLoading(false);
      if (ok) setTimelineFetched(true);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (timelineOpen && !timelineFetched) fetchTimeline();
  }, [timelineOpen, timelineFetched, fetchTimeline]);

  if (loading && !profile) {
    return <div className="py-6 text-center text-xs text-cafe-muted">加载领导力数据...</div>;
  }
  if (error) {
    return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-500">{error}</div>;
  }
  if (!profile) return null;

  const titleLabel = profile.currentTitle?.label.zh ?? '铲屎官';

  return (
    <div
      className="rounded-xl bg-cafe-surface p-5 shadow-[0_1px_8px_rgba(0,0,0,0.03)]"
      style={{ borderTop: '3px solid #D4A574' }}
    >
      {/* ── Top: Level + Title ─────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-amber-100 to-orange-100 text-lg">
          {'\u2B50'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-cafe">铲屎官领导力</span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              Lv.{profile.leadershipLevel}
            </span>
          </div>
          <p className="text-xs text-cafe-muted">
            {titleLabel} · {profile.totalXp.toLocaleString()} 足迹点
          </p>
        </div>
      </div>

      {/* ── Middle: Radar + KPIs ───────────────────── */}
      <div className="mt-5 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <div className="shrink-0">
          <LeadershipRadarChart stats={profile.stats} size={200} />
        </div>
        <div className="grid w-full flex-1 grid-cols-2 gap-3">
          {LEADERSHIP_LIVE_DIMS.map((dim) => {
            const stat = profile.stats[dim];
            return stat ? <KpiCard key={dim} stat={stat} /> : null;
          })}
        </div>
      </div>

      {/* ── Bottom: Timeline ───────────────────────── */}
      <div className="mt-4 border-t border-cafe-surface-elevated pt-2">
        <button
          onClick={() => setTimelineOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 text-xs text-cafe-secondary transition-colors hover:text-cafe"
        >
          <span
            className="text-[10px]"
            style={{
              transform: timelineOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              display: 'inline-block',
              transition: 'transform 0.15s',
            }}
          >
            &#9654;
          </span>
          <span>领导时刻</span>
          {events.length > 0 && <span className="text-cafe-muted">({events.length})</span>}
        </button>
        {timelineOpen && (
          <div className="mt-2 max-h-48 overflow-y-auto">
            {timelineLoading ? (
              <div className="py-2 text-center text-xs text-cafe-muted">加载中...</div>
            ) : timelineError ? (
              <div className="py-2 text-center text-xs text-red-400">加载失败，请稍后重试</div>
            ) : events.length === 0 ? (
              <div className="py-2 text-center text-xs text-cafe-muted">暂无领导时刻记录</div>
            ) : (
              <div className="space-y-1">
                {events.map((ev, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-cafe-surface-elevated"
                  >
                    <span className="font-medium" style={{ color: '#D4A574' }}>
                      +{ev.xp}
                    </span>
                    <span className="text-cafe-secondary">{DIM_LABELS[ev.dimension] ?? ev.dimension}</span>
                    <span className="flex-1 text-cafe-muted">{SOURCE_LABELS[ev.source] ?? ev.source}</span>
                    <span className="text-cafe-muted">{relativeTime(ev.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
