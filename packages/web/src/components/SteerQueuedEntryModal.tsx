'use client';

import { useEffect, useRef } from 'react';

interface SteerQueuedEntryModalProps {
  onCancel: () => void;
  onConfirm: () => void;
  /** A draft has not entered Queue yet; a queued entry already has a durable receipt. */
  source?: 'draft' | 'queued';
}

export function SteerQueuedEntryModal({ onCancel, onConfirm, source = 'queued' }: SteerQueuedEntryModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const isDraft = source === 'draft';

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
          <h2 className="text-lg font-semibold text-cafe-black">Steer（强制停止并发送此消息）</h2>
          <p className="text-sm text-cafe-secondary mt-1">
            {isDraft
              ? '会停止目标当前回复，然后立即发送当前输入的消息。'
              : '会停止目标当前回复，然后立即发送这条排队消息。'}
          </p>
        </div>

        <div className="px-6 pb-5">
          <div className="w-full p-4 rounded-xl border border-[var(--conn-amber-ring)] bg-[var(--conn-amber-bg)]">
            <div className="text-sm font-medium text-[var(--conn-amber-text)]">⚠️ 会停止当前回复后发送此消息</div>
            <div className="text-xs text-cafe-secondary mt-1">
              {isDraft
                ? '这不是“追加到当前回复”；当前回复会被停止。已经完成的回复仍会保留在聊天记录中。'
                : '旧回复会被停止；系统只以这条已持久化消息启动一次。已经完成的回复仍会保留在聊天记录中。'}
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
            停止并发送
          </button>
        </div>
      </div>
    </div>
  );
}
