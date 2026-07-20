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

/** Video extensions — mirrors thread-artifacts-aggregator VIDEO_EXTENSIONS. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v', 'ogv']);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isSafeUrl(url: string): boolean {
  return /^\/uploads\//.test(url) || /^\/api\//.test(url) || /^https:\/\//.test(url);
}

function isVideoFile(block: RichFileBlock): boolean {
  if (block.mimeType?.startsWith('video/')) return true;
  const ext = block.fileName.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.has(ext);
}

export function FileBlock({ block }: { block: RichFileBlock }) {
  const ext = block.fileName.split('.').pop()?.toLowerCase() ?? '';
  const iconName = EXT_ICON_NAMES[ext] ?? 'file-text';
  const safeHref = isSafeUrl(block.url) ? block.url : undefined;

  // Video files: inline player with download fallback
  if (isVideoFile(block) && safeHref) {
    return (
      <div className="overflow-hidden rounded-lg border border-cafe">
        <video controls preload="metadata" className="max-h-[400px] w-full rounded-t-lg bg-black">
          <source src={safeHref} type={block.mimeType ?? 'video/mp4'} />
        </video>
        <div className="flex items-center gap-3 px-4 py-2">
          <HubIcon name="play" className="h-4 w-4 flex-shrink-0 text-cafe-muted" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-cafe-black truncate">{block.fileName}</div>
          </div>
          {block.fileSize != null && <div className="text-xs text-cafe-muted">{formatFileSize(block.fileSize)}</div>}
          <a href={safeHref} download={block.fileName} className="text-xs text-cafe-link hover:underline">
            下载
          </a>
        </div>
      </div>
    );
  }

  return (
    <a
      href={safeHref}
      download={safeHref ? block.fileName : undefined}
      className="flex items-center gap-3 rounded-lg border border-cafe px-4 py-3 hover:bg-cafe-surface-elevated  transition-colors"
    >
      <HubIcon name={iconName} className="h-6 w-6 flex-shrink-0 text-cafe-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-cafe-black  truncate">{block.fileName}</div>
        {block.fileSize != null && <div className="text-xs text-cafe-muted">{formatFileSize(block.fileSize)}</div>}
      </div>
    </a>
  );
}
