'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { CatStatusType, LivenessWarningSnapshot } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ExecutionCancelButton } from './ExecutionCancelButton';

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function livenessDetail(warning: LivenessWarningSnapshot, fallback: string): string {
  if (warning.firstEventAt === null) {
    return 'CLI 进程已启动，但尚未返回任何事件；可能卡在客户端初始化';
  }
  if (warning.lastEventType === 'turn.started' || warning.lastEventType === 'thread.started') {
    return 'CLI 已开始回合，但之后没有模型或工具事件；可能卡在客户端初始化或上游连接';
  }
  return fallback;
}

/** Lucide timer icon (inline SVG to avoid emoji per design spec) */
function TimerIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="10" x2="14" y1="2" y2="2" />
      <line x1="12" x2="12" y1="14" y2="10" />
      <circle cx="12" cy="14" r="8" />
    </svg>
  );
}

/** Lucide triangle-alert icon */
function TriangleAlertIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <line x1="12" x2="12" y1="9" y2="13" />
      <line x1="12" x2="12.01" y1="17" y2="17" />
    </svg>
  );
}

interface ThinkingIndicatorProps {
  onCancel?: (threadId: string, catId?: string) => void;
  threadId?: string;
}

function LivenessWarningBanner({
  status,
  warning,
  name,
  execution,
}: {
  status: CatStatusType;
  warning?: LivenessWarningSnapshot;
  name: string;
  execution: ActiveExecutionProjection;
}) {
  if (!warning || (status !== 'alive_but_silent' && status !== 'suspected_stall')) return null;
  const stalled = status === 'suspected_stall';
  const elapsed = formatDuration(warning.silenceDurationMs);
  const detail = stalled
    ? livenessDetail(
        warning,
        warning.state === 'idle-silent' ? '进程存活但 CPU 平坦，未检测到工具执行或 API 活动' : '进程可能无响应',
      )
    : livenessDetail(
        warning,
        warning.state === 'busy-silent'
          ? '进程存活且 CPU 活跃，可能正在执行工具或等待 API 响应'
          : '进程存活，等待响应中',
      );
  const color = stalled ? 'var(--semantic-critical)' : 'var(--semantic-warning)';
  return (
    <div
      data-testid="liveness-warning"
      className="px-5 py-3 border-b"
      style={{
        backgroundColor: stalled ? 'var(--semantic-critical-surface)' : 'var(--semantic-warning-surface)',
        borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {stalled ? (
            <TriangleAlertIcon className="w-4 h-4 flex-shrink-0" style={{ color }} />
          ) : (
            <TimerIcon className="w-4 h-4 animate-pulse flex-shrink-0" style={{ color }} />
          )}
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold" style={{ color: 'var(--cafe-text)' }}>
              {stalled ? `${name} 可能卡住了 — ${elapsed} 无输出` : `${name} 静默等待中… ${elapsed}`}
            </span>
            <span className="text-xs" style={{ color: 'var(--cafe-text-secondary)' }}>
              {detail}
            </span>
          </div>
        </div>
        <ExecutionCancelButton
          execution={execution}
          label="取消"
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-[var(--cafe-surface)] flex-shrink-0 transition-opacity hover:opacity-90 ${
            stalled ? 'bg-[var(--semantic-critical)]' : 'bg-[var(--semantic-warning)]'
          }`}
        />
      </div>
    </div>
  );
}

/**
 * Single-cat thinking indicator.
 * Shows a simple banner when only one cat is being invoked (execute mode).
 * F118 Phase C: Extended with liveness warning states.
 */
export function ThinkingIndicator({ onCancel, threadId }: ThinkingIndicatorProps) {
  void onCancel;
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const effectiveThreadId = threadId ?? currentThreadId;
  const { catStatuses, catStatusDetails, catInvocations } = useThreadLiveness(effectiveThreadId);
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const { getCatById } = useCatData();

  const executions = useMemo(
    () =>
      Object.values(executionsByKey).filter(
        (execution) => execution.threadId === effectiveThreadId && execution.kind === 'live_invocation',
      ),
    [effectiveThreadId, executionsByKey],
  );
  if (executions.length !== 1) return null;
  const execution = executions[0];
  if (!execution) return null;
  const catId = execution.catId;
  const status: CatStatusType = catStatuses[catId] ?? 'pending';
  if (status === 'done') return null;

  const name = resolveCatDisplayName(catId, getCatById);
  const warning: LivenessWarningSnapshot | undefined = catInvocations?.[catId]?.livenessWarning;

  // F118 D2: spawning — CLI not yet connected, earliest signal
  if (status === 'spawning') {
    return (
      <div className="px-5 py-2 border-b border-cafe bg-cafe-surface-elevated">
        <div className="flex items-center gap-2">
          <span className="text-sm leading-none animate-bounce">🐾</span>
          <span className="text-sm text-cafe-secondary">
            {name} · {execution.threadTitle ?? execution.threadId} · 实时回合启动中
          </span>
          <span className="flex items-center gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="inline-block w-1 h-1 rounded-full bg-cafe-secondary animate-bounce"
                style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.8s' }}
              />
            ))}
          </span>
          <ExecutionCancelButton execution={execution} label="取消" className="ml-auto text-xs text-cafe-muted" />
        </div>
      </div>
    );
  }

  if (warning && (status === 'alive_but_silent' || status === 'suspected_stall')) {
    return <LivenessWarningBanner status={status} warning={warning} name={name} execution={execution} />;
  }

  // Default: normal thinking/streaming indicator.
  // F210 H3: agy trajectory 进度（catStatusDetails）覆盖默认"回复中/思考中"，让 agy 长任务过程在
  // chat 区单行可见（折叠，不刷屏；done 后该 cat 不在 streaming/pending → 此分支不渲染）。
  const agyProgress = catStatusDetails?.[catId];
  return (
    <div className="px-5 py-2 border-b border-cafe bg-cafe-surface-elevated">
      <div className="flex items-center gap-2">
        <span className="text-sm leading-none animate-bounce">🐾</span>
        <span className="text-sm text-cafe-secondary">
          {name}
          {agyProgress ? ` · ${agyProgress}` : status === 'streaming' ? '回复中' : '思考中'}
          {` · ${execution.threadTitle ?? execution.threadId} · 实时回合`}
        </span>
        <ExecutionCancelButton execution={execution} label="取消" className="ml-auto text-xs text-cafe-muted" />
        {/* #738: animated typing dots */}
        <span className="flex items-center gap-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block w-1 h-1 rounded-full bg-cafe-secondary animate-bounce"
              style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.8s' }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
