'use client';

import { useEffect, useRef } from 'react';

export function SteerQueuedEntryModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
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
          <p className="text-sm text-cafe-secondary mt-1">取消目标猫当前回合，并以这条消息立即重新启动。</p>
        </div>

        <div className="px-6 pb-5">
          <div className="w-full p-4 rounded-xl border border-[var(--conn-amber-ring)] bg-[var(--conn-amber-bg)]">
            <div className="text-sm font-medium text-[var(--conn-amber-text)]">⚠️ 取消当前回合并重新启动</div>
            <div className="text-xs text-cafe-secondary mt-1">
              旧 invocation 会被取消；系统只以这条已持久化消息启动一次。取消前已经完成的回复仍会发表，不会被这次 Steer
              吞掉。
            </div>
          </div>
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
