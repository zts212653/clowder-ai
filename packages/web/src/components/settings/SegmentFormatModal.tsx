'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SettingsText } from './primitives';

const FORMAT_EXAMPLES: Record<string, { description: string; example: string }> = {
  M1: {
    description: '任务调度上下文，按 mission、work item 与 phase 的固定字段投影。',
    example: 'mission: F257\nwork_item: Harness Ledger\nphase: implementation',
  },
  M2: {
    description: '会话连续性索引，提供可检索的 session 数量与精确读取入口。',
    example: '47 previous sealed session(s) are available by exact drill.',
  },
  N2: {
    description: '当前线程的增量对话窗口，保留消息坐标、时间、发送者与正文。',
    example: '[message-id] [2026-09-08 03:09 UTC co-creator] 示例消息正文',
  },
};

interface SegmentFormatModalProps {
  segment: {
    id: string;
    name: string;
    sourceType: string;
    source: string;
    trigger: string;
    purpose: string;
  };
  onClose: () => void;
}

export function SegmentFormatModal({ segment, onClose }: SegmentFormatModalProps) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const format = FORMAT_EXAMPLES[segment.id] ?? {
    description: segment.purpose,
    example: `来源：${segment.source}\n触发：${segment.trigger}`,
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <button type="button" aria-label="关闭" className="absolute inset-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-format-title"
        className="relative w-full max-w-[700px] rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg">
            ◫
          </div>
          <h2 id="segment-format-title" className="min-w-0 flex-1 text-xl font-bold text-cafe">
            <span className="mr-2 font-mono text-base text-cafe-muted">{segment.id}</span>
            {segment.name}
          </h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="console-icon-button">
            ✕
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
            <SettingsText as="h3" variant="sm" className="font-semibold">
              格式说明
            </SettingsText>
            <SettingsText as="p" variant="xs" tone="secondary" className="mt-2">
              {format.description}
            </SettingsText>
            <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
              {segment.sourceType} · {segment.source}
            </SettingsText>
          </section>
          <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
            <SettingsText as="h3" variant="sm" className="font-semibold">
              格式示例
            </SettingsText>
            <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-[var(--console-card-bg)] p-3 font-mono text-xs leading-relaxed text-cafe-secondary">
              {format.example}
            </pre>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
