'use client';

import { useCatData } from '@/hooks/useCatData';
import type { CatStatusType, LivenessWarningSnapshot } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
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
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <line x1="12" x2="12" y1="9" y2="13" />
      <line x1="12" x2="12.01" y1="17" y2="17" />
    </svg>
  );
}

/** Lucide square icon */
function SquareIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  );
}

interface ThinkingIndicatorProps {
  onCancel?: (threadId: string) => void;
}

/**
 * Single-cat thinking indicator.
 * Shows a simple banner when only one cat is being invoked (execute mode).
 * F118 Phase C: Extended with liveness warning states.
 */
export function ThinkingIndicator({ onCancel }: ThinkingIndicatorProps = {}) {
  const targetCats = useChatStore((s) => s.targetCats);
  const catStatuses = useChatStore((s) => s.catStatuses);
  const catInvocations = useChatStore((s) => s.catInvocations);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const { getCatById } = useCatData();

  if (targetCats.length !== 1) return null;
  const catId = targetCats[0];
  const status: CatStatusType = catStatuses[catId] ?? 'pending';
  if (status === 'done') return null;

  const catData = getCatById(catId);
  const name = catData?.displayName ?? catId;
  const warning: LivenessWarningSnapshot | undefined = catInvocations?.[catId]?.livenessWarning;

  // F118: alive_but_silent — amber warning banner
  if (status === 'alive_but_silent' && warning) {
    const elapsed = formatDuration(warning.silenceDurationMs);
    return (
      <div
        data-testid="liveness-warning"
        className="px-5 py-3 border-b"
        style={{ backgroundColor: '#FFF8E7', borderColor: '#D4A64A33' }}
      >
        <div className="flex items-center gap-2.5">
          <TimerIcon className="w-4 h-4 animate-pulse" style={{ color: '#D4A64A' }} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-semibold" style={{ color: '#1A1918' }}>
              {name} 静默等待中… {elapsed}
            </span>
            <span className="text-xs" style={{ color: '#6D6C6A' }}>
              {warning.state === 'busy-silent'
                ? '进程存活且 CPU 活跃，可能正在执行工具或等待 API 响应'
                : '进程存活，等待响应中'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // F118: suspected_stall — orange warning banner with cancel button
  if (status === 'suspected_stall' && warning) {
    const elapsed = formatDuration(warning.silenceDurationMs);
    return (
      <div
        data-testid="liveness-warning"
        className="px-5 py-3 border-b"
        style={{ backgroundColor: '#FFF0ED', borderColor: '#D0806833' }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <TriangleAlertIcon className="w-4 h-4 flex-shrink-0" style={{ color: '#D08068' }} />
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[13px] font-semibold" style={{ color: '#1A1918' }}>
                {name} 可能卡住了 — {elapsed} 无输出
              </span>
              <span className="text-xs" style={{ color: '#6D6C6A' }}>
                {warning.state === 'idle-silent'
                  ? '进程存活但 CPU 平坦，未检测到工具执行或 API 活动'
                  : '进程可能无响应'}
              </span>
            </div>
          </div>
          {onCancel && currentThreadId && (
            <button
              data-testid="cancel-btn"
              onClick={() => onCancel(currentThreadId)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-[10px] text-[13px] font-semibold text-white flex-shrink-0 transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#D08068' }}
            >
              <SquareIcon className="w-3.5 h-3.5" />
              取消
            </button>
          )}
        </div>
      </div>
    );
  }

  // Default: normal thinking/streaming indicator
  return (
    <div className="px-5 py-2 border-b border-gray-200 bg-gray-50">
      <div className="flex items-center gap-2">
        <span className="text-base leading-none animate-pulse" role="img" aria-label="paw">
          🐾
        </span>
        <span className="text-sm text-gray-500">
          {name}
          {status === 'streaming' ? '回复中...' : '思考中...'}
        </span>
      </div>
    </div>
  );
}
