'use client';

import type { RichFileBlock } from '@/stores/chat-types';

const EXT_ICONS: Record<string, string> = {
  pdf: '📄',
  doc: '📝',
  docx: '📝',
  xls: '📊',
  xlsx: '📊',
  ppt: '📎',
  pptx: '📎',
  md: '📋',
  txt: '📋',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isSafeUrl(url: string): boolean {
  return /^\/uploads\//.test(url) || /^\/api\//.test(url) || /^https:\/\//.test(url);
}

export function FileBlock({ block }: { block: RichFileBlock }) {
  const ext = block.fileName.split('.').pop()?.toLowerCase() ?? '';
  const icon = EXT_ICONS[ext] ?? '📎';
  const safeHref = isSafeUrl(block.url) ? block.url : undefined;

  return (
    <a
      href={safeHref}
      download={safeHref ? block.fileName : undefined}
      className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
    >
      <span className="text-2xl flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe-black dark:text-gray-200 truncate">{block.fileName}</div>
        {block.fileSize != null && <div className="text-xs text-gray-400">{formatFileSize(block.fileSize)}</div>}
      </div>
    </a>
  );
}
