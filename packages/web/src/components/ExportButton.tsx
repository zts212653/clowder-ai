'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { DownloadIcon } from './icons/DownloadIcon';

type ExportFormat = 'png' | 'md' | 'txt';

interface ExportOption {
  format: ExportFormat;
  label: string;
  description: string;
}

const EXPORT_OPTIONS: ExportOption[] = [
  { format: 'png', label: '导出长图', description: 'PNG 截图' },
  { format: 'md', label: '下载聊天记录', description: 'Markdown' },
  { format: 'txt', label: '下载聊天记录', description: '纯文本' },
];

export function ExportButton({
  threadId,
  variant = 'thread-menu',
  onSelect,
}: {
  threadId: string;
  variant?: 'thread-menu';
  onSelect?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      setMenuOpen(false);
      onSelect?.();
      setLoading(true);
      try {
        if (format === 'png') {
          await exportImage(threadId);
        } else {
          await exportText(threadId, format);
        }
      } catch (error) {
        console.error('导出失败:', error);
        alert(`导出失败：${error instanceof Error ? error.message : '未知错误'}`);
      } finally {
        setLoading(false);
      }
    },
    [onSelect, threadId],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={loading}
        className="flex w-full items-center gap-2 bg-transparent px-3 py-1.5 text-left text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-black disabled:cursor-not-allowed disabled:opacity-50"
        title="导出对话"
        aria-label="导出对话"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        role={variant === 'thread-menu' ? 'menuitem' : undefined}
      >
        {loading ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            className="h-3 w-3 animate-spin text-cafe-secondary"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 019.8 8" />
          </svg>
        ) : (
          <DownloadIcon className="h-3 w-3 text-cafe-secondary" />
        )}
        <span>导出对话</span>
      </button>

      {menuOpen && (
        <div
          className="absolute right-0 top-full z-[60] mt-1 w-52 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] py-1 shadow-lg"
          role="menu"
          aria-label="导出格式"
        >
          {EXPORT_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.format}
              onClick={() => handleExport(opt.format)}
              role="menuitem"
              className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--console-hover-bg)] transition-colors flex items-center justify-between"
            >
              <span className="text-cafe-black">{opt.label}</span>
              <span className="text-xs text-cafe-muted">{opt.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

async function exportImage(threadId: string): Promise<void> {
  const res = await apiFetch(`/api/threads/${threadId}/export-image`, {
    method: 'POST',
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string; message?: string };
    throw new Error(data.message || data.error || '导出失败');
  }
  const blob = await res.blob();
  downloadBlob(blob, `chat-${threadId}-${Date.now()}.png`);
}

async function exportText(threadId: string, format: 'md' | 'txt'): Promise<void> {
  const res = await apiFetch(`/api/export/thread/${threadId}?format=${format}`);
  if (!res.ok) {
    const data = (await res.json()) as { error?: string; message?: string };
    throw new Error(data.message || data.error || '导出失败');
  }
  const text = await res.text();
  const ext = format === 'md' ? 'md' : 'txt';
  const mime = format === 'md' ? 'text/markdown' : 'text/plain';
  const blob = new Blob([text], { type: `${mime}; charset=utf-8` });
  downloadBlob(blob, `thread-${threadId}.${ext}`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
