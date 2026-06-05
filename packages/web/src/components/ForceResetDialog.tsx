'use client';

import { useEffect, useRef } from 'react';

/**
 * F220 Phase 3 — force-reset 确认弹窗（AC-3.2 / AC-3.3）。
 * 真相源：docs/features/F220-a2a-collab-reliability.md §设计稿 + assets/F220/force-reset-mock.html
 * 点击不立即执行——先讲清 做什么/保留什么/何时用，确认才 onConfirm。
 * LL-048：force-reset 只清运行态，绝不碰消息/历史/记忆等持久化数据（文案明示"会保留什么"）。
 */
interface ForceResetDialogProps {
  open: boolean;
  /** 调用 force-reset 端点期间禁用确认，防双触发 */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const SVG_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconBan() {
  return (
    <svg {...SVG_PROPS} aria-hidden className="w-[17px] h-[17px] flex-shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg {...SVG_PROPS} aria-hidden className="w-[17px] h-[17px] flex-shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg {...SVG_PROPS} aria-hidden className="w-[17px] h-[17px] flex-shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg {...SVG_PROPS} aria-hidden className="w-4 h-4">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function ForceResetDialog({ open, busy = false, onCancel, onConfirm }: ForceResetDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // §设计稿：取消是默认 focus（危险操作的安全侧默认）。
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="强制重置这个对话"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ backgroundColor: 'color-mix(in srgb, var(--cafe-text) 32%, transparent)' }}
    >
      <div className="w-full max-w-sm rounded-2xl overflow-hidden bg-cafe-surface-elevated shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-cafe">
          <h3 className="text-sm font-bold" style={{ color: 'var(--cafe-text)' }}>
            强制重置这个对话？
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="text-cafe-muted hover:text-cafe-secondary transition-colors"
          >
            <IconClose />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3" style={{ color: 'var(--cafe-text)' }}>
          <div className="flex gap-2.5 items-start text-sm">
            <span style={{ color: 'var(--semantic-critical)' }}>
              <IconBan />
            </span>
            <span>
              <b className="font-semibold">会做什么：</b>取消这个对话里所有正在运行的猫，清掉卡住的“正在回复中”。
            </span>
          </div>
          <div className="flex gap-2.5 items-start text-sm">
            <span style={{ color: 'var(--semantic-success, oklch(0.55 0.10 150))' }}>
              <IconCheck />
            </span>
            <span>
              <b className="font-semibold">会保留什么：</b>消息和历史全部保留——只清运行状态。
            </span>
          </div>
          <div className="flex gap-2.5 items-start text-sm">
            <span style={{ color: 'var(--cafe-text-secondary)' }}>
              <IconInfo />
            </span>
            <span>
              <b className="font-semibold">何时用：</b>仅在猫卡死、点「停止」也没反应时的最后手段。
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2.5 px-5 py-3.5 border-t border-cafe">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm font-semibold border border-cafe bg-cafe-surface-elevated"
            style={{ color: 'var(--cafe-text)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
            style={{ backgroundColor: 'var(--semantic-critical)' }}
          >
            强制重置
          </button>
        </div>
      </div>
    </div>
  );
}
