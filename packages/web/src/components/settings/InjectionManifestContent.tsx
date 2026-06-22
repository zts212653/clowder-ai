'use client';

/**
 * F237 — Injection manifest viewer with lifecycle flow diagram.
 * User-facing lifecycle pipeline with sub-stage grouping.
 * client-invoke = assembled prompt preview point (system + turn + user).
 * hook-events = event-driven, separate HookManagementPanel.
 *
 * Stage detail rendering extracted to StageDetailPanels.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { CatDimensionSelector } from './CatDimensionSelector';
import { CompiledPreviewModal } from './CompiledPreviewModal';
import { LifecycleFlowDiagram } from './LifecycleFlowDiagram';
import { getStageForSegment, LIFECYCLE_STAGES } from './lifecycle-stages';
import { SettingsBadge, SettingsPrimaryButton, SettingsSection, SettingsText } from './primitives';
import { type ManifestSegment, StageDetailPanel } from './StageDetailPanels';

// ── Types ──────────────────────────────────────────────────────

interface ManifestResponse {
  schemaVersion: string;
  segments: ManifestSegment[];
  totalActive: number;
  totalLegacy: number;
}

// ── Main component ──────────────────────────────────────────────

interface InjectionManifestContentProps {
  /** Notifies parent when the selected lifecycle stage changes */
  onStageChange?: (stageId: string | null) => void;
  /** Slot forwarded into StageDetailPanel after carrier info (e.g. L0 template card) */
  slotAfterCarrier?: React.ReactNode;
}

export function InjectionManifestContent({ onStageChange, slotAfterCarrier }: InjectionManifestContentProps) {
  const [data, setData] = useState<ManifestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [showCompiledPreview, setShowCompiledPreview] = useState(false);
  const { cats } = useCatData();
  const selectedCat = cats.find((c) => c.id === selectedCatId);
  const handleSelectStage = useCallback(
    (stageId: string) => {
      setSelectedStageId(stageId);
      onStageChange?.(stageId);
    },
    [onStageChange],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/prompt-injection/manifest');
        if (cancelled) return;
        if (!res.ok) {
          setError('注入段清单加载失败');
          return;
        }
        setData((await res.json()) as ManifestResponse);
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeSegments = useMemo(
    () =>
      data?.segments.filter((s) => !s._status || (!s._status.startsWith('legacy') && s._status !== 'removed')) ?? [],
    [data],
  );

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const seg of activeSegments) {
      const stageId = getStageForSegment(seg.id);
      if (stageId) counts[stageId] = (counts[stageId] ?? 0) + 1;
    }
    return counts;
  }, [activeSegments]);

  const stageSegments = useMemo(() => {
    if (!selectedStageId) return [];
    return activeSegments.filter((seg) => getStageForSegment(seg.id) === selectedStageId);
  }, [activeSegments, selectedStageId]);

  const selectedStage = LIFECYCLE_STAGES.find((s) => s.id === selectedStageId);

  if (error)
    return (
      <SettingsText as="p" variant="sm" tone="red">
        {error}
      </SettingsText>
    );
  if (!data)
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        加载中...
      </SettingsText>
    );

  return (
    <div className="space-y-6">
      {/* Summary */}
      <SettingsSection
        title="会话生命周期"
        description="猫的会话执行管线。点击阶段查看注入详情，高亮 = 注入点，浅色 = 影响范围。"
        badge={
          <SettingsBadge tone="slate">
            {data.totalActive} 活跃 · {data.totalLegacy} 遗留
          </SettingsBadge>
        }
      />

      <LifecycleFlowDiagram
        selectedStageId={selectedStageId}
        onSelectStage={handleSelectStage}
        segmentCounts={stageCounts}
      />

      {/* Stage detail — unified for all stages (including hook-events) */}
      {selectedStage && (
        <StageDetailPanel stage={selectedStage} segments={stageSegments} slotAfterCarrier={slotAfterCarrier} />
      )}
      {/* Assembled prompt preview — only when client-invoke is selected */}
      {selectedStageId === 'client-invoke' && (
        <div className="flex flex-wrap items-center gap-3">
          <CatDimensionSelector selected={selectedCatId} onSelect={setSelectedCatId} />
          {selectedCatId && (
            <SettingsPrimaryButton onClick={() => setShowCompiledPreview(true)}>预览</SettingsPrimaryButton>
          )}
        </div>
      )}

      {!selectedStageId && (
        <SettingsText as="p" variant="sm" tone="muted" className="py-4 text-center">
          点击上方任意阶段查看注入段详情
        </SettingsText>
      )}

      {showCompiledPreview && selectedCatId && (
        <CompiledPreviewModal
          catId={selectedCatId}
          catName={selectedCat?.displayName ?? selectedCatId}
          onClose={() => setShowCompiledPreview(false)}
        />
      )}
    </div>
  );
}
