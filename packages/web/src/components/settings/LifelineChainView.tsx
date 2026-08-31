'use client';

/**
 * F257 Phase D — Version lifecycle chain visualization.
 *
 * Horizontal scrollable chain of version epochs:
 *   [v1] → [tracing(445)] → [eval(pass)] → [governance] → [v2] → [tracing(12)] → ...
 *
 * Each badge is clickable — selecting a stage shows its detail in LifelineStageDetail.
 */

import type { ActionableInfo, ActiveStage } from '@cat-cafe/shared';
import { useCallback } from 'react';
import { SettingsBadge, SettingsText } from './primitives';
import { explainVerdict } from './verdict-explanations';

// ── Types ──────────────────────────────────────────────────────

interface VersionEpoch {
  version: number;
  origin: string;
  startedAt: number;
  status: string;
  isActive: boolean;
  tracing: {
    observationCount: number;
    /** 判据② P1 (sol R5): producer-semantics fired count (observe-only rows excluded). */
    firedCount: number;
    firstAt: number | null;
    lastAt: number | null;
  } | null;
  eval: { verdict: string | null; injectionCount: number; violationCount: number; evaluatedAt: number | null } | null;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  events: Array<{ eventId: string; kind: string; timestamp: number; actorId: string; detail: string }>;
}

export interface SelectedStage {
  version: number;
  stage: 'version' | 'tracing' | 'eval' | 'governance';
}

interface LifelineChainViewProps {
  chain: VersionEpoch[];
  selected: SelectedStage | null;
  onSelect: (stage: SelectedStage) => void;
  /** 判据①: real loop stage of the ACTIVE version (from the read model). */
  activeStage: ActiveStage;
  /** 判据①: actionable only via real pending Candidates (honest gap when unwired). */
  actionable: ActionableInfo;
}

// ── Badge tone mapping ─────────────────────────────────────────

type BadgeTone = 'emerald' | 'amber' | 'red' | 'blue' | 'slate';

function versionTone(epoch: VersionEpoch): BadgeTone {
  return epoch.isActive ? 'blue' : 'slate';
}

function tracingTone(epoch: VersionEpoch): BadgeTone {
  if (!epoch.tracing || epoch.tracing.observationCount === 0) return 'slate';
  return 'emerald';
}

function evalTone(epoch: VersionEpoch): BadgeTone {
  if (!epoch.eval || !epoch.eval.verdict) return 'slate';
  return explainVerdict(epoch.eval.verdict).tone;
}

function governanceTone(epoch: VersionEpoch, isActionable: boolean): BadgeTone {
  // 判据① P1-4: real pending Candidates are the ONLY attention signal —
  // independent of the synthesized epoch.governance.decision.
  if (isActionable) return 'amber';
  if (!epoch.governance || !epoch.governance.decision) return 'slate';
  if (epoch.governance.decision === 'approved') return 'emerald';
  // synthesized pending is informational only.
  return 'slate';
}

// ── Labels ─────────────────────────────────────────────────────

function tracingLabel(epoch: VersionEpoch): string {
  if (!epoch.tracing || epoch.tracing.observationCount === 0) return 'tracing';
  return `tracing(${epoch.tracing.observationCount})`;
}

function evalLabel(epoch: VersionEpoch): string {
  if (!epoch.eval || !epoch.eval.verdict) return 'eval';
  const ic = epoch.eval.injectionCount;
  const vc = epoch.eval.violationCount;
  const rate = ic > 0 ? `${((vc / ic) * 100).toFixed(0)}%` : '';
  return `eval(${explainVerdict(epoch.eval.verdict).label}${rate ? ` ${rate}` : ''})`;
}

/** Verdict explanation for the eval badge tooltip (判据③). */
function evalTitle(epoch: VersionEpoch): string | undefined {
  if (!epoch.eval || !epoch.eval.verdict) return undefined;
  return explainVerdict(epoch.eval.verdict).explanation;
}

function governanceLabel(epoch: VersionEpoch, actionable: ActionableInfo, isActionable: boolean): string {
  // 判据① P1-4: candidate count comes from the Candidate projection alone —
  // shown even when epoch.governance is null (e.g. retire-candidate verdict).
  if (isActionable) return `governance(${actionable.candidateCount} 待审)`;
  if (!epoch.governance || !epoch.governance.decision) return 'governance';
  // 判据①: never render synthesized pending as 待处理 — stay neutral (honest gap).
  if (epoch.governance.decision === 'pending') return 'governance';
  return `governance(${epoch.governance.decision})`;
}

/** 判据①: tooltip for the governance badge — honest about what pending means. */
function governanceTitle(epoch: VersionEpoch, actionable: ActionableInfo, isActionable: boolean): string | undefined {
  if (isActionable) return `需 operator 决策：${actionable.candidateCount} 个治理候选待审`;
  if (epoch.governance?.decision !== 'pending') return undefined;
  // P2-2: verdict-neutral wording — dormant ≠ pass, so never say 评估已通过.
  if (actionable.source === 'unavailable') {
    return '评估完成，生命周期位于治理环节；治理候选数据暂不可用，无法判断是否需要 operator 操作';
  }
  return '评估完成，当前无治理候选（无需动作）';
}

// ── Helpers ────────────────────────────────────────────────────

function isSelected(selected: SelectedStage | null, version: number, stage: SelectedStage['stage']): boolean {
  return selected?.version === version && selected?.stage === stage;
}

// ── Component ──────────────────────────────────────────────────

export function LifelineChainView({ chain, selected, onSelect, activeStage, actionable }: LifelineChainViewProps) {
  const handleSelect = useCallback(
    (version: number, stage: SelectedStage['stage']) => {
      onSelect({ version, stage });
    },
    [onSelect],
  );

  if (chain.length === 0) {
    return (
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        无生命线数据
      </SettingsText>
    );
  }

  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        版本生命线
      </SettingsText>
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2">
        {chain.map((epoch, idx) => (
          <EpochNode
            key={epoch.version}
            epoch={epoch}
            selected={selected}
            onSelect={handleSelect}
            showArrowBefore={idx > 0}
            activeStage={activeStage}
            actionable={actionable}
          />
        ))}
      </div>
    </div>
  );
}

// ── Epoch node ─────────────────────────────────────────────────

function EpochNode({
  epoch,
  selected,
  onSelect,
  showArrowBefore,
  activeStage,
  actionable,
}: {
  epoch: VersionEpoch;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage']) => void;
  showArrowBefore: boolean;
  activeStage: ActiveStage;
  actionable: ActionableInfo;
}) {
  // 判据①: the loop's real position — only on the ACTIVE version's epoch.
  const loopAt = (stage: SelectedStage['stage']) => epoch.isActive && activeStage === stage;
  const loopSuffix = (stage: SelectedStage['stage']) => (loopAt(stage) ? '◈' : undefined);
  const loopTitle = (stage: SelectedStage['stage']) => (loopAt(stage) ? '当前循环所在阶段' : undefined);
  // 判据①: actionable ONLY from real pending Candidates on the active epoch.
  const govActionable = epoch.isActive && actionable.stage === 'governance';

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {showArrowBefore && <Arrow />}

      {/* Version badge */}
      <StageBadge
        label={`v${epoch.version}`}
        tone={versionTone(epoch)}
        active={isSelected(selected, epoch.version, 'version')}
        suffix={epoch.isActive ? '●' : undefined}
        onClick={() => onSelect(epoch.version, 'version')}
      />
      <Arrow />

      {/* Tracing badge — loop marker when the cycle is (back) at tracing (判据①) */}
      <StageBadge
        label={tracingLabel(epoch)}
        tone={tracingTone(epoch)}
        active={isSelected(selected, epoch.version, 'tracing')}
        suffix={loopSuffix('tracing')}
        title={loopTitle('tracing')}
        onClick={() => onSelect(epoch.version, 'tracing')}
      />
      <Arrow />

      {/* Eval badge — verdict tone + hover explanation (判据③) */}
      <StageBadge
        label={evalLabel(epoch)}
        tone={evalTone(epoch)}
        title={evalTitle(epoch)}
        active={isSelected(selected, epoch.version, 'eval')}
        onClick={() => onSelect(epoch.version, 'eval')}
      />
      <Arrow />

      {/* Governance badge — actionable only via real Candidates; pending alone is informational (判据①) */}
      <StageBadge
        label={governanceLabel(epoch, actionable, govActionable)}
        tone={governanceTone(epoch, govActionable)}
        active={isSelected(selected, epoch.version, 'governance')}
        suffix={loopSuffix('governance')}
        title={governanceTitle(epoch, actionable, govActionable) ?? loopTitle('governance')}
        actionable={govActionable}
        onClick={() => onSelect(epoch.version, 'governance')}
      />
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────────

function StageBadge({
  label,
  tone,
  active,
  suffix,
  title,
  actionable = false,
  onClick,
}: {
  label: string;
  tone: BadgeTone;
  active: boolean;
  suffix?: string;
  title?: string;
  /** 判据①: stage awaits an operator decision — a separate visual channel from `active`. */
  actionable?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="relative cursor-pointer rounded-full transition-all active:scale-[0.98]"
    >
      {actionable && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--color-amber-500)]"
        />
      )}
      <SettingsBadge
        tone={tone}
        size="xxs"
        className={
          active
            ? '!bg-cafe-accent !text-[var(--cafe-accent-foreground)] shadow-[var(--shadow-elevation-1)]'
            : undefined
        }
      >
        {label}
        {suffix && <span className="ml-1 text-micro">{suffix}</span>}
      </SettingsBadge>
    </button>
  );
}

function Arrow() {
  return <span className="text-micro text-cafe-muted">→</span>;
}
