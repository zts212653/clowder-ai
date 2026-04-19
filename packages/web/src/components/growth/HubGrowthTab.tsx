'use client';

import type { CatGrowthProfile, GrowthOverview } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CatProfileCard } from './CatProfileCard';
import { CoCreatorCard } from './CoCreatorCard';
import { GrowthDetailModal } from './GrowthDetailModal';
import { LeadershipPanel } from './LeadershipPanel';

const CO_CREATOR_ID = 'co-creator';

export function HubGrowthTab() {
  const [overview, setOverview] = useState<GrowthOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<CatGrowthProfile | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/journey/overview');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? '加载失败');
        return;
      }
      setOverview((await res.json()) as GrowthOverview);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const coCreator = overview?.profiles.find((p) => p.catId === CO_CREATOR_ID);
  const catProfiles = overview?.profiles.filter((p) => p.catId !== CO_CREATOR_ID) ?? [];

  return (
    <div className="flex flex-col gap-8 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xl font-semibold text-cafe">猫猫足迹</h2>
          <p className="mt-0.5 text-xs text-cafe-muted">真实协作数据结晶 · 六维特质 · AI Agent 历练之旅</p>
        </div>
        {overview ? (
          <div className="text-right">
            <span className="text-2xl font-bold" style={{ color: '#9B7EBD' }}>
              Lv.{overview.teamLevel}
            </span>
            <p className="text-xs text-cafe-muted">团队历练 · {overview.teamTotalXp.toLocaleString()} 足迹点</p>
          </div>
        ) : null}
      </div>

      {loading && !overview ? (
        <div className="flex items-center justify-center py-12 text-sm text-cafe-muted">加载中...</div>
      ) : null}
      {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-500">{error}</div> : null}

      {overview ? (
        <>
          {/* Leadership panel — co-creator leadership dimensions */}
          <section>
            <h3 className="mb-3 text-sm font-medium text-cafe-secondary">铲屎官领导力</h3>
            <LeadershipPanel />
          </section>

          {/* Co-Creator section — distinct from cats */}
          {coCreator && (
            <section>
              <h3 className="mb-3 text-sm font-medium text-cafe-secondary">铲屎官</h3>
              <CoCreatorCard profile={coCreator} onClick={() => setSelectedProfile(coCreator)} />
            </section>
          )}

          {/* Cat grid — more breathing room */}
          {catProfiles.length > 0 && (
            <section>
              <h3 className="mb-3 text-sm font-medium text-cafe-secondary">猫猫团队</h3>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {catProfiles.map((profile) => (
                  <CatProfileCard key={profile.catId} profile={profile} onClick={() => setSelectedProfile(profile)} />
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}

      {overview && overview.profiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-cafe-muted">
          <p className="text-sm">还没有猫猫足迹数据</p>
          <p className="mt-1 text-xs">猫猫完成任务、review 代码后会自动积累足迹点</p>
        </div>
      ) : null}

      {/* Detail modal */}
      {selectedProfile && <GrowthDetailModal profile={selectedProfile} onClose={() => setSelectedProfile(null)} />}
    </div>
  );
}
