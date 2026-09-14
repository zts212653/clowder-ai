'use client';

/**
 * F257 — version and Objective-cycle lifecycle projection.
 *
 * A content version may survive several evaluation cycles. Each version keeps
 * one compact cycle card and expands a chooser on demand; parentVersion edges
 * form the visible tree so rollback branches do not need prose labels.
 */

import type { SegmentCycleSummary, VersionEpoch } from '@cat-cafe/shared';
import { useCallback } from 'react';
import { LifelineVersionTree, type VersionTreeRow } from './LifelineVersionTree';
import { SettingsBadge, SettingsText } from './primitives';
import { explainVerdict } from './verdict-explanations';

export interface SelectedStage {
  version: number;
  stage: 'version' | 'tracing' | 'eval' | 'governance';
  cycleId?: string;
}

interface LifelineChainViewProps {
  chain: VersionEpoch[];
  cycles?: SegmentCycleSummary[];
  currentCycleId?: string | null;
  selected: SelectedStage | null;
  onSelect: (stage: SelectedStage) => void;
}

export function LifelineChainView({
  chain,
  cycles = [],
  currentCycleId = null,
  selected,
  onSelect,
}: LifelineChainViewProps) {
  const handleSelect = useCallback(
    (version: number, stage: SelectedStage['stage'], cycleId?: string) => {
      onSelect({ version, stage, ...(cycleId ? { cycleId } : {}) });
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
      <div className="overflow-x-auto pb-1">
        <LifelineVersionTree chain={chain}>
          {(row) => (
            <EpochNode
              row={row}
              cycles={cyclesForEpoch(row.epoch, cycles)}
              currentCycleId={currentCycleId}
              selected={selected}
              onSelect={handleSelect}
            />
          )}
        </LifelineVersionTree>
      </div>
    </div>
  );
}

function EpochNode({
  cycles,
  currentCycleId,
  selected,
  onSelect,
  row,
}: {
  cycles: SegmentCycleSummary[];
  currentCycleId: string | null;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
  row: VersionTreeRow;
}) {
  const { epoch, parentVersion } = row;
  const selectedCycle = cycles.find((cycle) => cycle.cycleId === selected?.cycleId);
  const currentCycle = cycles.find((cycle) => cycle.cycleId === currentCycleId);
  const visibleCycle = selectedCycle ?? currentCycle ?? cycles.at(-1) ?? null;
  const visibleCycleIndex = visibleCycle ? cycles.findIndex((cycle) => cycle.cycleId === visibleCycle.cycleId) : -1;

  return (
    <>
      <StageBadge
        label={`v${epoch.version}`}
        stage="version"
        title={parentVersion === null ? undefined : `v${epoch.version} · 源自 v${parentVersion}`}
        selected={isSelected(selected, epoch.version, 'version')}
        current={epoch.isActive && cycles.length === 0 && epoch.status === 'idle'}
        onClick={() => onSelect(epoch.version, 'version')}
      />

      {visibleCycle ? (
        <>
          <Arrow />
          <CycleStages
            version={epoch.version}
            cycle={visibleCycle}
            localOrdinal={visibleCycleIndex + 1}
            cycles={cycles}
            isCurrentCycle={
              visibleCycle.cycleId === currentCycleId || (!currentCycleId && visibleCycle.closedAt == null)
            }
            selected={selected}
            onSelect={onSelect}
          />
        </>
      ) : (
        <>
          <Arrow />
          <LegacyCycleStages epoch={epoch} selected={selected} onSelect={onSelect} />
        </>
      )}
    </>
  );
}

function CycleStages({
  version,
  cycle,
  localOrdinal,
  cycles,
  isCurrentCycle,
  selected,
  onSelect,
}: {
  version: number;
  cycle: SegmentCycleSummary;
  localOrdinal: number;
  cycles: SegmentCycleSummary[];
  isCurrentCycle: boolean;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
}) {
  const currentStage = isCurrentCycle ? activeStageForCycle(cycle) : null;
  const stages: Array<{ stage: 'tracing' | 'eval' | 'governance'; title: string }> = [
    { stage: 'tracing', title: `周期起点：${new Date(cycle.cycleStart).toLocaleString()}` },
    {
      stage: 'eval',
      title: cycle.evaluation ? `评估已回写：${cycle.evaluation.overall}` : '等待本周期评估',
    },
    {
      stage: 'governance',
      title: cycle.governance ? `治理结论：${cycle.governance.decision}` : '等待本周期治理',
    },
  ];

  return (
    <div
      data-cycle-group={cycle.cycleId}
      data-cycle-surface
      className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg bg-[var(--console-card-bg)] px-2 py-1"
    >
      {stages.map(({ stage, title }, index) => (
        <span key={stage} className="flex shrink-0 items-center gap-1.5">
          {index > 0 && <Arrow />}
          <StageBadge
            label={stage}
            stage={stage}
            cycleId={cycle.cycleId}
            title={title}
            selected={isSelected(selected, version, stage, cycle.cycleId)}
            current={currentStage === stage}
            onClick={() => onSelect(version, stage, cycle.cycleId)}
          />
        </span>
      ))}
      <select
        data-cycle-switcher
        aria-label={`v${version} 周期`}
        value={cycle.cycleId}
        onChange={(event) => {
          const next = cycles.find((candidate) => candidate.cycleId === event.currentTarget.value);
          if (next) onSelect(version, activeStageForCycle(next), next.cycleId);
        }}
        className="ml-1 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-2 py-0.5 text-micro text-cafe-secondary outline-none focus:border-cafe-accent"
        title={`当前为本版本周期 ${localOrdinal}；周期起点：${new Date(cycle.cycleStart).toLocaleString()}`}
      >
        {cycles.map((candidate, index) => (
          <option
            key={candidate.cycleId}
            data-cycle-option
            data-option-cycle-id={candidate.cycleId}
            value={candidate.cycleId}
          >
            周期 {index + 1}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Compatibility while cycle data is loading or unavailable. */
function LegacyCycleStages({
  epoch,
  selected,
  onSelect,
}: {
  epoch: VersionEpoch;
  selected: SelectedStage | null;
  onSelect: (version: number, stage: SelectedStage['stage'], cycleId?: string) => void;
}) {
  const currentStage = epoch.isActive ? legacyActiveStage(epoch) : null;
  const evalTitle = explainVerdict(epoch.eval?.verdict).explanation;
  const stages: Array<{ stage: 'tracing' | 'eval' | 'governance'; title?: string }> = [
    { stage: 'tracing' },
    { stage: 'eval', title: evalTitle },
    { stage: 'governance' },
  ];
  return (
    <div
      data-cycle-group={`legacy-v${epoch.version}`}
      data-cycle-surface
      className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--console-card-bg)] px-2 py-1"
    >
      {stages.map(({ stage, title }) => (
        <span key={stage} className="flex shrink-0 items-center gap-1.5">
          {stage !== 'tracing' && <Arrow />}
          <StageBadge
            label={stage}
            stage={stage}
            title={title}
            selected={isSelected(selected, epoch.version, stage)}
            current={currentStage === stage}
            onClick={() => onSelect(epoch.version, stage)}
          />
        </span>
      ))}
    </div>
  );
}

function StageBadge({
  label,
  stage,
  cycleId,
  selected,
  current,
  title,
  onClick,
}: {
  label: string;
  stage: SelectedStage['stage'];
  cycleId?: string;
  selected: boolean;
  current: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const className = `rounded-full transition-all ${onClick ? 'cursor-pointer active:scale-[0.98]' : ''}`;
  const badge = (
    <SettingsBadge
      tone="slate"
      size="xxs"
      className={
        selected
          ? '!bg-cafe-accent !text-[var(--cafe-accent-foreground)] shadow-[var(--shadow-elevation-1)]'
          : undefined
      }
    >
      {label}
    </SettingsBadge>
  );
  const sharedProps = {
    title,
    'aria-current': current ? ('step' as const) : undefined,
    'data-stage': stage,
    'data-cycle-id': cycleId,
    'data-current': String(current),
    className,
  };

  if (!onClick) return <span {...sharedProps}>{badge}</span>;
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} {...sharedProps}>
      {badge}
    </button>
  );
}

function cyclesForEpoch(epoch: VersionEpoch, cycles: SegmentCycleSummary[]): SegmentCycleSummary[] {
  return cycles
    .filter((cycle) => cycle.segmentVersion === epoch.version)
    .sort((left, right) => left.cycleStart - right.cycleStart || left.cycleId.localeCompare(right.cycleId));
}

export function activeStageForCycle(cycle: SegmentCycleSummary): 'tracing' | 'eval' | 'governance' {
  if (cycle.termination) return 'governance';
  if (cycle.evalStatus === 'idle') return 'tracing';
  if (cycle.evalStatus === 'requested' || cycle.evalStatus === 'retriggered' || cycle.evalStatus === 'stalled') {
    return 'eval';
  }
  return 'governance';
}

function legacyActiveStage(epoch: VersionEpoch): 'tracing' | 'eval' | 'governance' {
  if (epoch.status === 'eval-pending') return 'eval';
  if (epoch.status === 'governance-pending' || epoch.status === 'governance-approved' || epoch.status === 'eval-pass') {
    return 'governance';
  }
  return 'tracing';
}

function isSelected(
  selected: SelectedStage | null,
  version: number,
  stage: SelectedStage['stage'],
  cycleId?: string,
): boolean {
  return (
    selected?.version === version && selected.stage === stage && (stage === 'version' || selected.cycleId === cycleId)
  );
}

function Arrow() {
  return <span className="text-micro text-cafe-muted">→</span>;
}
