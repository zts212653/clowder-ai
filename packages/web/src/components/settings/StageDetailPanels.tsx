'use client';

/**
 * F237 — Stage detail sub-components for the injection manifest viewer.
 * Extracted from InjectionManifestContent to respect the 350-line limit.
 *
 * Contains: StageDetailPanel, SubStageGroup, SegmentRow,
 * CarrierInfoPanel, and badge maps.
 */

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
  _knownIssue?: string;
  _status?: string;
}

// ── Non-template source type labels ───────────────────────────

const SOURCE_TYPE_LABELS: Record<string, string> = {
  'config-driven': '配置驱动 — 从 cat-config.json 等配置文件生成',
  'rule-generated': '规则生成 — 从 shared-rules.md 确定性提取',
  hook: '钩子 — 由 harness 在特定条件下触发注入',
};

// ── Badge maps ─────────────────────────────────────────────────

/**
 * Tag-based editability + governance badges.
 * Primary tag: 只读 (readonly, red) or 可编辑 (editable, emerald).
 * Secondary tags for editable segments reflect governance tier:
 *   人工审批(开发中) = human-gated auto-evolve (amber)
 *   自动迭代(开发中) = fully automatic evolve (blue)
 * No secondary tag = manual edit only, no auto harness.
 */
type TagTone = 'red' | 'emerald' | 'amber' | 'blue';
interface SegmentTag {
  label: string;
  tone: TagTone;
}
function resolveSegmentTags(safetyTier: string, governanceTier: string, allowLocalOverride: boolean): SegmentTag[] {
  // Effective editability: both governance policy AND implementation must agree
  if (safetyTier === 'readonly' || !allowLocalOverride) {
    return [{ label: '只读', tone: 'red' }];
  }
  const tags: SegmentTag[] = [{ label: '可编辑', tone: 'emerald' }];
  if (governanceTier === 'human-gated') {
    tags.push({ label: '人工审批(开发中)', tone: 'amber' });
  } else if (governanceTier === 'auto-evolve') {
    tags.push({ label: '自动迭代(开发中)', tone: 'blue' });
  }
  return tags;
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
// Hook toggle/dry-run removed from F237 scope (CVO: "当前 PR 多余").
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
  const [infoOpen, setInfoOpen] = useState(false);
  const tags = resolveSegmentTags(s.safetyTier, s.governanceTier, s.allowLocalOverride);
  // Hooks are viewable only when source points to a file (not a directory)
  const isViewable = s.sourceType === 'template' || (s.sourceType === 'hook' && !!s.source && !s.source.endsWith('/'));

  const handleCardClick = () => {
    if (isViewable) setEditorOpen(true);
    else setInfoOpen((v) => !v);
  };

  return (
    <div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: card click is supplementary to the text button */}
      <div
        className="flex items-start gap-3 rounded-lg px-3 py-2 cursor-pointer transition-colors hover:brightness-95"
        style={{
          backgroundColor: 'var(--console-elevated-bg)',
          boxShadow: '0 1px 4px rgba(43,33,26,0.08)',
        }}
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
            {tags.map((tag) => (
              <SettingsBadge key={tag.label} tone={tag.tone} size="xxs">
                {tag.label}
              </SettingsBadge>
            ))}
            {s._knownIssue && (
              <SettingsBadge tone="amber" size="xxs">
                已知问题
              </SettingsBadge>
            )}
            <span className="ml-auto text-xs opacity-50">
              {isViewable ? (s.allowLocalOverride ? '编辑' : '查看') : infoOpen ? '收起' : '详情'}
            </span>
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
      </div>
      {/* Non-viewable inline info panel (config-driven / rule-generated) */}
      {!isViewable && infoOpen && (
        <div
          className="ml-11 mt-1 space-y-1.5 rounded-lg px-3 py-2"
          style={{ backgroundColor: 'var(--console-card-soft-bg)' }}
        >
          <SegmentInfoRow label="来源类型" value={SOURCE_TYPE_LABELS[s.sourceType] ?? s.sourceType} />
          <SegmentInfoRow label="来源" value={s.source} />
          <SegmentInfoRow label="触发条件" value={s.trigger} />
          <SegmentInfoRow label="用途" value={s.purpose} />
        </div>
      )}
      {editorOpen && (
        <SegmentEditorModal
          segmentId={s.id}
          segmentName={s.name}
          allowLocalOverride={s.allowLocalOverride}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

function SegmentInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <SettingsText as="span" variant="xs" tone="muted" className="w-16 shrink-0">
        {label}
      </SettingsText>
      <SettingsText as="span" variant="xs" tone="secondary">
        {value}
      </SettingsText>
    </div>
  );
}
