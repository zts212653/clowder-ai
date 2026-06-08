'use client';

import { useEffect, useRef } from 'react';

export type SteerMode = 'immediate' | 'promote';

export function SteerQueuedEntryModal({
  mode,
  onCancel,
  onConfirm,
  onModeChange,
}: {
  mode: SteerMode;
  onCancel: () => void;
  onConfirm: () => void;
  onModeChange: (mode: SteerMode) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-close, keyboard Escape handled via useEffect
    <div
      role="presentation"
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel();
      }}
    >
      <div ref={modalRef} className="bg-cafe-surface rounded-2xl shadow-2xl w-full max-w-[520px] mx-4 overflow-hidden">
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-cafe-black">Steer 这条排队消息</h2>
          <p className="text-sm text-cafe-secondary mt-1">选择你希望如何处理这条 queued 消息：</p>
        </div>

        <div className="px-6 pb-5 space-y-3">
          {/* 安全默认选项置顶，防止惯性误触 */}
          <button
            type="button"
            data-testid="steer-mode-promote"
            onClick={() => onModeChange('promote')}
            className={`w-full text-left p-4 rounded-xl border transition-colors ${
              mode === 'promote'
                ? 'border-[var(--color-cocreator-primary)]'
                : 'border-cafe hover:border-cafe bg-cafe-surface'
            }`}
            style={
              mode === 'promote'
                ? { backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 5%, transparent)' }
                : undefined
            }
          >
            <div className="text-sm font-medium text-cafe">提到队首（不取消）</div>
            <div className="text-xs text-cafe-secondary mt-1">只调整顺序；当前猫跑完后优先执行这条消息。</div>
          </button>

          {/* 高风险选项置底，选中时用警告色强调破坏性 */}
          <button
            type="button"
            data-testid="steer-mode-immediate"
            onClick={() => onModeChange('immediate')}
            className={`w-full text-left p-4 rounded-xl border transition-colors ${
              mode === 'immediate' ? 'border-[var(--conn-amber-ring)]' : 'border-cafe hover:border-cafe bg-cafe-surface'
            }`}
            style={mode === 'immediate' ? { backgroundColor: 'var(--conn-amber-bg)' } : undefined}
          >
            <div
              className="text-sm font-medium"
              style={{ color: mode === 'immediate' ? 'var(--conn-amber-text)' : undefined }}
            >
              ⚠️ 立即执行（必要时中断目标猫）
            </div>
            <div className="text-xs text-cafe-secondary mt-1">
              若目标猫正在执行，会先 cancel 该猫当前 invocation；若目标猫空闲，则直接执行这条排队消息。
            </div>
            {mode === 'immediate' && (
              <div className="text-xs mt-2" style={{ color: 'var(--conn-amber-text)' }}>
                ⚠️ 警告：此操作会强行掐断当前正在运行的猫，可能导致进行中的工作丢失。
              </div>
            )}
          </button>
        </div>

        <div className="px-6 pb-6 flex items-center justify-between">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-cafe-secondary hover:text-cafe-secondary transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="steer-confirm"
            onClick={onConfirm}
            className="text-sm px-4 py-2 rounded-full bg-[var(--color-cocreator-primary)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
