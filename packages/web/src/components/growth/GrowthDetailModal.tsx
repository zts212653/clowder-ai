'use client';

import type { CatGrowthProfile, GrowthDimension } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { DownloadIcon } from '@/components/icons/DownloadIcon';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { AchievementWall } from './AchievementWall';
import { EvolutionTimeline } from './EvolutionTimeline';
import { GrowthRadarChart } from './GrowthRadarChart';
import { SkillTreePanel } from './SkillTreePanel';
import { XpAuditLog } from './XpAuditLog';

const DIM_LABELS: Record<GrowthDimension, string> = {
  architecture: '架构力',
  review: '审查力',
  aesthetics: '审美力',
  execution: '执行力',
  collaboration: '协作力',
  insight: '洞察力',
};

const DIMENSIONS: GrowthDimension[] = ['architecture', 'review', 'aesthetics', 'execution', 'collaboration', 'insight'];

interface Props {
  profile: CatGrowthProfile;
  onClose: () => void;
}

export function GrowthDetailModal({ profile, onClose }: Props) {
  const { getCatById } = useCatData();
  const catData = getCatById(profile.catId);
  const primaryColor = catData?.color?.primary ?? '#9B7EBD';
  const { attributes } = profile;
  const { stats, overallLevel, totalXp } = attributes;

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await apiFetch(`/api/journey/${profile.catId}/export-image`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message || body.error || '导出失败');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${profile.nickname ?? profile.displayName}-journey.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出失败');
      setTimeout(() => setExportError(null), 4000);
    } finally {
      setExporting(false);
    }
  }, [profile.catId, profile.nickname, profile.displayName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="relative mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-cafe-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header */}
        <div className="flex items-center gap-3 border-b border-cafe-surface-elevated px-6 py-4">
          {catData?.avatar ? (
            <img src={catData.avatar} alt="" className="h-11 w-11 rounded-full" />
          ) : (
            <div
              className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-bold text-white"
              style={{ backgroundColor: primaryColor }}
            >
              {profile.displayName.charAt(0)}
            </div>
          )}
          <div className="flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold text-cafe">{profile.nickname ?? profile.displayName}</span>
              <span
                className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
                style={{ backgroundColor: primaryColor }}
              >
                {/* Lv. maps to 历练 (Seasoning) */}
                Lv.{overallLevel}
              </span>
            </div>
            <span className="text-xs text-cafe-muted">
              {profile.currentTitle?.label.zh ?? profile.displayName}
              {' · '}
              {totalXp.toLocaleString()} 足迹点
            </span>
          </div>
          <ExportButton exporting={exporting} error={exportError} onClick={handleExport} />
          <button
            onClick={onClose}
            className="ml-1 rounded-lg p-1.5 text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Radar + dimension bars — side by side on desktop */}
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <div className="shrink-0">
              <GrowthRadarChart stats={stats} size={220} color={primaryColor} />
            </div>
            <div className="w-full space-y-2.5">
              {DIMENSIONS.map((d) => {
                const s = stats[d];
                if (!s) return null;
                const progress =
                  s.xpToNext > 0 ? (s.xp - s.level * s.level * 100) / (s.xpToNext + s.xp - s.level * s.level * 100) : 1;
                return (
                  <div key={d} className="flex items-center gap-2 text-xs">
                    <span className="w-14 text-right text-cafe-secondary">{DIM_LABELS[d]}</span>
                    <span className="w-8 font-medium" style={{ color: primaryColor }}>
                      Lv.{s.level}
                    </span>
                    <div className="h-2 flex-1 rounded-full bg-cafe-surface-elevated">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(progress * 100, 100)}%`,
                          backgroundColor: primaryColor,
                          opacity: 0.7,
                        }}
                      />
                    </div>
                    <span className="w-16 text-right text-cafe-muted">{s.xp.toLocaleString()} 足迹点</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Evolution timeline (AC-E2) */}
          <div className="mt-6">
            <EvolutionTimeline catId={profile.catId} color={primaryColor} />
          </div>

          {/* XP audit log */}
          <div className="mt-6">
            <XpAuditLog catId={profile.catId} color={primaryColor} defaultOpen />
          </div>

          {/* Titles + bonds */}
          <div className="mt-6">
            <SkillTreePanel profile={profile} />
          </div>

          {/* Phase C: Moments (珍贵瞬间) wall */}
          <div className="mt-6">
            <AchievementWall memberId={profile.catId} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportButton({
  exporting,
  error,
  onClick,
}: {
  exporting: boolean;
  error: string | null;
  onClick: () => void;
}) {
  return (
    <div className="relative">
      <button
        onClick={onClick}
        disabled={exporting}
        className="rounded-lg p-1.5 transition-colors hover:bg-cafe-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
        title="导出足迹名片 PNG"
      >
        {exporting ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-4 w-4 animate-spin text-cafe-secondary"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 019.8 8" />
          </svg>
        ) : (
          <DownloadIcon className="h-4 w-4 text-cafe-secondary" />
        )}
      </button>
      {error && (
        <div className="absolute right-0 top-full mt-1 whitespace-nowrap rounded bg-red-50 px-2 py-1 text-[10px] text-red-500 shadow">
          {error}
        </div>
      )}
    </div>
  );
}
