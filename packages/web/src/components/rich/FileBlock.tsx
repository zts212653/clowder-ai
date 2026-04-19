'use client';

import type { RichFileBlock } from '@/stores/chat-types';
import { HubIcon } from '../hub-icons';

const EXT_ICON_NAMES: Record<string, string> = {
  pdf: 'file-text',
  doc: 'file-text',
  docx: 'file-text',
  xls: 'bar-chart',
  xlsx: 'bar-chart',
  ppt: 'file-text',
  pptx: 'file-text',
  md: 'file-text',
  txt: 'file-text',
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
  const iconName = EXT_ICON_NAMES[ext] ?? 'file-text';
  const safeHref = isSafeUrl(block.url) ? block.url : undefined;

  return (
    <a
      href={safeHref}
      download={safeHref ? block.fileName : undefined}
      className="flex items-center gap-3 rounded-lg border border-cafe dark:border-gray-700 px-4 py-3 hover:bg-cafe-surface-elevated dark:hover:bg-gray-800/50 transition-colors"
    >
      <HubIcon name={iconName} className="h-6 w-6 flex-shrink-0 text-cafe-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe-black dark:text-gray-200 truncate">{block.fileName}</div>
        {block.fileSize != null && <div className="text-xs text-cafe-muted">{formatFileSize(block.fileSize)}</div>}
      </div>
    </a>
  );
}
