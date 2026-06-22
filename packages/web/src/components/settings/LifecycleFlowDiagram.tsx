'use client';

/**
 * F237 — Session lifecycle flow diagram with multi-level nesting.
 *
 * Shows the actual execution hierarchy:
 *   Thread → Session Loop → Turn Loop → Client Invoke
 *
 * Layout (nested boxes):
 *   ┌─ ↻ 会话循环 ──────────────────────────────────────┐
 *   │ [会话创建] → [会话初始化]                           │
 *   │  ┌─ ↻ 回合循环 ──────────────────────────────────┐ │
 *   │  │ [回合构建] → [👁 客户端调用] → [回合结束] ↻   │ │
 *   │  └────────────────────────────────────────────────┘ │
 *   │ [会话结束] ↻                                        │
 *   └────────────────────────────────────────────────────┘
 *   ┌─ ⚡ 事件驱动 ──────────┐
 *   │ [Hook 事件]             │
 *   └─────────────────────────┘
 */

import { Fragment, useMemo } from 'react';
import { computeInfluenceSet, EVENT_STAGES, type LifecycleStage, PIPELINE_STAGES } from './lifecycle-stages';
import { SettingsText } from './primitives';

interface LifecycleFlowDiagramProps {
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
  segmentCounts: Record<string, number>;
}

type NodeState = 'default' | 'selected' | 'influenced';

// Derive visual groups from nestLevel
const SESSION_INIT = PIPELINE_STAGES.filter((s) => s.nestLevel === 'session' && s.id !== 'session-close');
const TURN_STAGES = PIPELINE_STAGES.filter((s) => s.nestLevel === 'turn');
const SESSION_CLOSE = PIPELINE_STAGES.filter((s) => s.id === 'session-close');

// Nesting depth tokens: outer = canvas (lightest), inner = progressively darker
const LOOP_BORDER = '1.5px dashed var(--cafe-border, rgba(139, 115, 85, 0.25))';
const SECTION_BG = 'var(--console-card-bg)'; // 层4 浮出 — top-level sections
const SECTION_SHADOW = '0 8px 22px rgba(43,33,26,0.04)'; // 层4 container shadow
const NESTED_BG = 'var(--console-panel-bg)'; // 层2 承载 — inner nesting (darker)

export function LifecycleFlowDiagram({ selectedStageId, onSelectStage, segmentCounts }: LifecycleFlowDiagramProps) {
  const influenceSet = useMemo(() => computeInfluenceSet(selectedStageId), [selectedStageId]);

  const getState = (id: string): NodeState => {
    if (id === selectedStageId) return 'selected';
    if (influenceSet.has(id)) return 'influenced';
    return 'default';
  };

  const node = (stage: LifecycleStage) => (
    <StageNode
      stage={stage}
      state={getState(stage.id)}
      count={segmentCounts[stage.id] ?? 0}
      onClick={() => onSelectStage(stage.id)}
    />
  );

  return (
    <div className="space-y-3">
      {/* ── Session loop (outer) ── */}
      <div
        className="space-y-3 rounded-2xl p-3"
        style={{ border: LOOP_BORDER, background: SECTION_BG, boxShadow: SECTION_SHADOW }}
      >
        <SettingsText as="span" variant="xs" tone="muted" className="block">
          ↻ 会话循环 — 上下文溢出/压缩时封存当前会话，下次调用创建新会话
        </SettingsText>

        {/* Session init row */}
        <div className="flex flex-wrap items-center gap-2">
          {SESSION_INIT.map((stage, i) => (
            <Fragment key={stage.id}>
              {node(stage)}
              {i < SESSION_INIT.length - 1 && <Arrow />}
            </Fragment>
          ))}
        </div>

        {/* ── Turn loop (inner, nested) ── */}
        <div className="space-y-2 rounded-xl p-3" style={{ border: LOOP_BORDER, background: NESTED_BG }}>
          <SettingsText as="span" variant="xs" tone="muted" className="block">
            ↻ 回合循环 — 每次消息交互为一个回合
          </SettingsText>
          <div className="flex flex-wrap items-center gap-2">
            {TURN_STAGES.map((stage, i) => (
              <Fragment key={stage.id}>
                {node(stage)}
                {i < TURN_STAGES.length - 1 && <Arrow />}
              </Fragment>
            ))}
          </div>
        </div>

        {/* Session close row */}
        <div className="flex flex-wrap items-center gap-2">
          {SESSION_CLOSE.map((stage) => (
            <Fragment key={stage.id}>{node(stage)}</Fragment>
          ))}
        </div>
      </div>

      {/* ── Event-driven lane ── */}
      {EVENT_STAGES.length > 0 && (
        <div
          className="rounded-2xl p-3"
          style={{ border: LOOP_BORDER, background: SECTION_BG, boxShadow: SECTION_SHADOW, opacity: 0.85 }}
        >
          <SettingsText as="span" variant="xs" tone="muted" className="mb-2 block">
            ⚡ 事件驱动（不在主管线内）
          </SettingsText>
          <div className="flex flex-wrap items-center gap-2">
            {EVENT_STAGES.map((stage) => (
              <Fragment key={stage.id}>{node(stage)}</Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── StageNode ────────────────────────────────────────────────

/**
 * Uniform "weak border" button style matching SettingsSecondaryButton.
 * All stages use the same base style; only bg/border/text vary by state.
 */
const COLORS: Record<NodeState, { bg: string; shadow: string; text: string }> = {
  default: {
    bg: 'var(--console-elevated-bg)',
    shadow: '0 1px 4px rgba(43,33,26,0.10)',
    text: 'var(--cafe-text-secondary)',
  },
  selected: {
    bg: 'var(--cafe-accent)',
    shadow: '0 2px 6px rgba(43,33,26,0.15)',
    text: 'var(--cafe-accent-foreground, #fff)',
  },
  influenced: {
    bg: 'color-mix(in srgb, var(--cafe-accent) 8%, transparent)',
    shadow: '0 1px 3px rgba(43,33,26,0.06)',
    text: 'var(--cafe-text-secondary)',
  },
};

function StageNode({
  stage,
  state,
  count,
  onClick,
}: {
  stage: LifecycleStage;
  state: NodeState;
  count: number;
  onClick: () => void;
}) {
  const c = COLORS[state];

  return (
    <button
      type="button"
      onClick={onClick}
      title={stage.description}
      className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 transition-colors hover:bg-[var(--console-hover-bg)] active:scale-[0.98]"
      style={{
        backgroundColor: c.bg,
        boxShadow: c.shadow,
        color: c.text,
      }}
    >
      {stage.isPreviewPoint && (
        <svg
          className="h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx={12} cy={12} r={3} />
        </svg>
      )}
      <span className="whitespace-nowrap text-xs font-medium">{stage.label}</span>
      {count > 0 && (
        <span
          className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none"
          style={{
            backgroundColor: state === 'selected' ? 'rgba(255,255,255,0.2)' : 'var(--console-active-bg)',
            color: state === 'selected' ? '#fff' : 'var(--cafe-text-muted)',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ── Arrow connector ─────────────────────────────────────────

function Arrow() {
  return (
    <span className="shrink-0 select-none text-xs" style={{ color: 'var(--cafe-text-muted)', opacity: 0.4 }}>
      →
    </span>
  );
}
