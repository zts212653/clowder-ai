'use client';

/**
 * F237 — Stage detail sub-components for the injection manifest viewer.
 * Extracted from InjectionManifestContent to respect the 350-line limit.
 *
 * Contains: StageDetailPanel, SubStageGroup, SegmentRow,
 * CarrierInfoPanel, and badge maps.
 */

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import type React from 'react';
import { useMemo, useState } from 'react';
import {
  type CarrierInfo,
  getSubStageForSegment,
  type LifecycleStage,
  SCOPE_LABELS,
  type SubStage,
} from './lifecycle-stages';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentEditorModal } from './SegmentEditorModal';
import { SegmentFormatModal } from './SegmentFormatModal';
import { SegmentLifelineModal } from './SegmentLifelineModal';

// ── Types (shared with InjectionManifestContent) ─────────────

export interface ManifestSegment {
  id: string;
  name: string;
  category: string;
  lifecycleStage: string;
  source: string;
  sourceType: string;
  trigger: string;
  purpose: string;
  userExplanation: string;
  priority: string;
  safetyTier: string;
  transparencyTier: string;
  governanceTier: string;
  allowLocalOverride: boolean;
  disableable: boolean;
  consumer: string;
  relatedFeature: string | null;
  enablementMatrix?: SegmentEnablementMatrix;
  _knownIssue?: string;
  _status?: string;
}

// ── Carrier position badge ───────────────────────────────────

const CARRIER_POSITION_BADGE: Record<string, { label: string; tone: 'emerald' | 'blue' | 'purple' }> = {
  'system-prompt': { label: '系统提示词', tone: 'emerald' },
  'message-context': { label: '消息上下文', tone: 'blue' },
  'event-output': { label: '事件输出', tone: 'purple' },
};

// ── Carrier info panel ──────────────────────────────────────

export function CarrierInfoPanel({ carrier }: { carrier: CarrierInfo }) {
  const badge = CARRIER_POSITION_BADGE[carrier.position];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <SettingsText as="span" variant="xs" tone="muted">
        注入位置：
      </SettingsText>
      {badge && (
        <SettingsBadge tone={badge.tone} size="xxs">
          {badge.label}
        </SettingsBadge>
      )}
      {carrier.clients.map((c) => (
        <SettingsText key={c.name} as="span" variant="xs" tone="muted">
          <span className="font-medium">{c.name}</span>: {c.mechanism}
        </SettingsText>
      ))}
    </div>
  );
}

// ── Event-driven stage panel (hook-events) ────────────────
// Hook toggle/dry-run removed from F237 scope (operator: "当前 PR 多余").
// Hook events stage now uses the same StageDetailPanel as all others.

// ── Stage detail panel ────────────────────────────────────────

export function StageDetailPanel({
  stage,
  segments,
  slotAfterCarrier,
}: {
  stage: LifecycleStage;
  segments: ManifestSegment[];
  /** Slot rendered between carrier info and sub-stage groups (e.g. L0 template) */
  slotAfterCarrier?: React.ReactNode;
}) {
  const subStageGroups = useMemo(() => {
    if (!stage.subStages?.length) return null;
    return stage.subStages.map((sub) => ({
      subStage: sub,
      segments: segments.filter((seg) => getSubStageForSegment(seg.id) === sub.id),
    }));
  }, [stage.subStages, segments]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SettingsText as="h3" variant="base" tone="default" className="font-bold">
          {stage.label}
        </SettingsText>
        {stage.hasInjection && (
          <SettingsBadge tone="emerald" size="xxs">
            {segments.length} 注入段
          </SettingsBadge>
        )}
        <SettingsText as="span" variant="xs" tone="muted">
          影响范围：{SCOPE_LABELS[stage.influenceScope]}
        </SettingsText>
      </div>
      <SettingsText as="p" variant="xs" tone="secondary">
        {stage.description}
      </SettingsText>

      {/* Carrier info — shows how injections are delivered to each client */}
      {stage.carrier && <CarrierInfoPanel carrier={stage.carrier} />}

      {/* Slot after carrier — e.g. L0 template card */}
      {slotAfterCarrier}

      {/* Sub-stage groups */}
      {subStageGroups?.map(({ subStage, segments: subSegs }) => (
        <SubStageGroup key={subStage.id} subStage={subStage} segments={subSegs} />
      ))}

      {/* Flat segment list (no sub-stages) */}
      {!subStageGroups && segments.length > 0 && (
        <div className="space-y-2">
          {segments.map((seg) => (
            <SegmentRow key={seg.id} segment={seg} />
          ))}
        </div>
      )}

      {/* Structural stages */}
      {!stage.hasInjection && (
        <SettingsText as="p" variant="xs" tone="muted" className="py-2 italic">
          此阶段无注入段（结构性阶段）
        </SettingsText>
      )}
    </div>
  );
}

// ── Sub-stage group ──────────────────────────────────────────

function SubStageGroup({ subStage, segments }: { subStage: SubStage; segments: ManifestSegment[] }) {
  return (
    <div
      className="space-y-2 rounded-xl p-3"
      style={{ backgroundColor: 'var(--console-card-bg)', boxShadow: '0 8px 22px rgba(43,33,26,0.04)' }}
    >
      <div className="flex items-center gap-2">
        <SettingsText as="h4" variant="sm" tone="default" className="font-semibold">
          {subStage.label}
        </SettingsText>
        <SettingsBadge tone="slate" size="xxs">
          {segments.length}
        </SettingsBadge>
      </div>
      <SettingsText as="p" variant="xs" tone="muted">
        {subStage.description}
      </SettingsText>
      {segments.length > 0 ? (
        <div className="space-y-2">
          {segments.map((seg) => (
            <SegmentRow key={seg.id} segment={seg} />
          ))}
        </div>
      ) : (
        <SettingsText as="p" variant="xs" tone="muted" className="italic">
          当前无活跃注入段
        </SettingsText>
      )}
    </div>
  );
}

// ── Segment row ─────────────────────────────────────────────────

function SegmentRow({ segment: s }: { segment: ManifestSegment }) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [lifelineOpen, setLifelineOpen] = useState(false);
  const supportsLifecycle = s.sourceType === 'template';

  const handleCardClick = () => {
    if (supportsLifecycle) setEditorOpen(true);
    else setFormatOpen(true);
  };

  return (
    <div>
      <div
        className="flex items-start gap-3 rounded-lg px-3 py-2 cursor-pointer transition-colors hover:brightness-95"
        style={{
          backgroundColor: 'var(--console-elevated-bg)',
          boxShadow: '0 1px 4px rgba(43,33,26,0.08)',
        }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 border-none bg-transparent p-0 text-left"
          onClick={handleCardClick}
        >
          <SettingsText as="span" variant="xs" tone="muted" className="mt-0.5 w-8 shrink-0 font-mono">
            {s.id}
          </SettingsText>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                {s.name}
              </SettingsText>
              {s._knownIssue && (
                <SettingsBadge tone="amber" size="xxs">
                  已知问题
                </SettingsBadge>
              )}
              <span className="ml-auto text-xs opacity-50">{supportsLifecycle ? '编辑' : '详情'}</span>
            </div>
            <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
              {s.userExplanation}
            </SettingsText>
            <div className="mt-1 flex flex-wrap gap-3">
              <SettingsText as="span" variant="xs" tone="muted">
                {s.sourceType}
              </SettingsText>
              {s.relatedFeature && (
                <SettingsText as="span" variant="xs" tone="muted">
                  {s.relatedFeature}
                </SettingsText>
              )}
            </div>
          </div>
        </button>
        {supportsLifecycle && (
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 opacity-50 hover:opacity-80"
            onClick={() => setLifelineOpen(true)}
            aria-label={`查看 ${s.id} 评估与回放`}
            title="查看评估与回放"
          >
            📊
          </button>
        )}
      </div>
      {editorOpen && <SegmentEditorModal segmentId={s.id} segmentName={s.name} onClose={() => setEditorOpen(false)} />}
      {formatOpen && <SegmentFormatModal segment={s} onClose={() => setFormatOpen(false)} />}
      {lifelineOpen && (
        <SegmentLifelineModal segmentId={s.id} segmentName={s.name} onClose={() => setLifelineOpen(false)} />
      )}
    </div>
  );
}
