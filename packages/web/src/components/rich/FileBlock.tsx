'use client';

import {
  messagePublicationSource,
  type PublishedMessageCoordinate,
  usePublishedContent,
} from '@/components/content-review/usePublishedContent';
import type { RichFileBlock } from '@/stores/chat-types';
import { CompactLabel } from '../content-overflow';
import { HubIcon } from '../hub-icons';
import { usePublishedFileOpen } from './usePublishedFileOpen';

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

export function FileBlock({
  block,
  publication,
  sourceThreadId,
  messageId,
  sourceMessageIds,
}: {
  block: RichFileBlock;
  publication?: PublishedMessageCoordinate;
  sourceThreadId?: string;
  messageId?: string;
  sourceMessageIds?: readonly string[];
}) {
  const ext = block.fileName.split('.').pop()?.toLowerCase() ?? '';
  const iconName = EXT_ICON_NAMES[ext] ?? 'file-text';
  const safeHref = isSafeUrl(block.url) ? block.url : undefined;
  const published = usePublishedContent();
  const source = messagePublicationSource(publication, { kind: 'rich-file', blockId: block.id }, block.url);
  const legacyPublication = usePublishedFileOpen(block.url, sourceThreadId, messageId, sourceMessageIds);
  if (source)
    return (
      <div className="rounded-lg border border-cafe p-3">
        <button
          type="button"
          disabled={published.busy}
          onClick={() => void published.open(source, block.fileName)}
          className="flex w-full items-center gap-3 text-left"
        >
          <HubIcon name={isVideoFile(block) ? 'play' : 'file-text'} className="h-5 w-5 shrink-0 text-cafe-muted" />
          <span className="min-w-0 flex-1 truncate text-sm">{block.fileName}</span>
          <span className="text-xs text-cafe-link">{published.busy ? '正在打开…' : '打开作品'}</span>
        </button>
        {published.error ? (
          <p role="alert" className="mt-2 text-xs text-cafe-error">
            {published.error}
          </p>
        ) : null}
      </div>
    );

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
            <CompactLabel label="文件名" value={block.fileName} className="text-sm font-medium text-cafe-black" />
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
    <div className="space-y-2">
      <div className="flex items-center gap-3 rounded-lg border border-cafe px-4 py-3 transition-colors hover:bg-cafe-surface-elevated">
        <HubIcon name={iconName} className="h-6 w-6 flex-shrink-0 text-cafe-muted" />
        <div className="min-w-0 flex-1">
          <CompactLabel label="文件名" value={block.fileName} className="text-sm font-medium text-cafe-black" />
          {block.fileSize != null && <div className="text-xs text-cafe-muted">{formatFileSize(block.fileSize)}</div>}
        </div>
        {safeHref && sourceThreadId && messageId ? (
          <button
            type="button"
            data-testid="file-block-open"
            onClick={() => void legacyPublication.open()}
            disabled={legacyPublication.loading}
            aria-busy={legacyPublication.loading}
            className="shrink-0 rounded-md bg-cafe-accent/10 px-2 py-1 text-xs font-medium text-cafe-accent hover:bg-cafe-accent/20 disabled:opacity-60"
          >
            {legacyPublication.loading ? '正在打开…' : '打开'}
          </button>
        ) : null}
        {safeHref && (
          <a href={safeHref} download={block.fileName} className="shrink-0 text-xs text-cafe-link hover:underline">
            下载
          </a>
        )}
      </div>
      {legacyPublication.error ? (
        <p role="alert" className="text-xs text-cafe-error">
          暂时无法定位这份已发布材料，请重试打开。
        </p>
      ) : null}
    </div>
  );
}
