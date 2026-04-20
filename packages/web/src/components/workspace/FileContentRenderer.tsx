'use client';

import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import { HubIcon } from '../hub-icons';
import { MarkdownContent } from '../MarkdownContent';
import { CodeViewer } from './CodeViewer';
import { JsxPreview } from './JsxPreview';

export interface FileContentRendererProps {
  file: FileData;
  openFilePath: string | null;
  isMarkdown: boolean;
  isHtml: boolean;
  isJsx: boolean;
  markdownRendered: boolean;
  htmlPreview: boolean;
  jsxPreview: boolean;
  editMode: boolean;
  scrollToLine: number | null;
  worktreeId: string | null;
  currentWorktree?: WorktreeEntry;
  mdContainerRef: React.RefObject<HTMLDivElement>;
  mdHasSelection: boolean;
  onMdAddToChat: () => void;
  onSave: (c: string) => Promise<void>;
  rawUrl: (p: string) => string;
  revealInFinder: (path: string) => void;
}

/** Renders file content: binary (image/audio/video), markdown, HTML, JSX, or code. */
export function FileContentRenderer({
  file,
  openFilePath,
  isMarkdown,
  isHtml,
  isJsx,
  markdownRendered,
  htmlPreview,
  jsxPreview,
  editMode,
  scrollToLine,
  worktreeId,
  currentWorktree,
  mdContainerRef,
  mdHasSelection,
  onMdAddToChat,
  onSave,
  rawUrl,
  revealInFinder,
}: FileContentRendererProps) {
  if (file.binary) {
    if (file.mime.startsWith('image/'))
      return (
        <div className="flex-1 flex items-center justify-center bg-[#1E1E24] p-4 overflow-auto">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={rawUrl(file.path)} alt={file.path} className="max-w-full max-h-full object-contain rounded" />
        </div>
      );
    if (file.mime.startsWith('audio/'))
      return (
        <div className="flex-1 flex flex-col items-center justify-center bg-[#1E1E24] p-6 gap-3">
          <HubIcon name="music" className="h-8 w-8 text-cafe-secondary" />
          <audio controls src={rawUrl(file.path)} className="w-full max-w-md">
            浏览器不支持音频播放
          </audio>
          <p className="text-[10px] text-cafe-secondary">
            {file.mime} · {Math.round(file.size / 1024)}KB
          </p>
        </div>
      );
    if (file.mime.startsWith('video/'))
      return (
        <div className="flex-1 flex items-center justify-center bg-[#1E1E24] p-4 overflow-auto">
          <video controls src={rawUrl(file.path)} className="max-w-full max-h-full rounded">
            浏览器不支持视频播放
          </video>
        </div>
      );
    return (
      <div className="flex flex-col items-center justify-center py-8 bg-[#1E1E24] text-cafe-secondary text-xs">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-7 w-7 mb-2 text-cafe-muted"
        >
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
        </svg>
        <p>二进制文件</p>
        <p className="text-[10px] mt-1">
          {file.mime} · {Math.round(file.size / 1024)}KB
        </p>
        <button
          type="button"
          onClick={() => void revealInFinder(file.path)}
          className="mt-2 px-3 py-1 rounded bg-cocreator-light/20 text-cocreator-dark/60 hover:bg-cocreator-light/40 transition-colors text-[10px]"
        >
          在 Finder 中打开
        </button>
      </div>
    );
  }

  if (isMarkdown && markdownRendered && !editMode)
    return (
      <div className="relative flex-1 min-h-0">
        <div className="h-full overflow-auto bg-cafe-white p-4" ref={mdContainerRef}>
          <MarkdownContent
            content={file.content}
            disableCommandPrefix
            basePath={openFilePath ? openFilePath.split('/').slice(0, -1).join('/') : undefined}
            worktreeId={worktreeId ?? undefined}
          />
        </div>
        {mdHasSelection && (
          <button
            type="button"
            onClick={onMdAddToChat}
            className="absolute top-2 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cocreator-primary text-white text-[11px] font-medium shadow-lg hover:bg-cocreator-dark transition-colors z-10 animate-fade-in"
            title="引用到聊天"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M1.5 2.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H5L2.5 11.5V9h-1a1 1 0 0 1-1-1V2.5Z" />
              <path d="M13.5 5v4a1 1 0 0 1-1 1H12v2.5L9.5 10H7a1 1 0 0 1-1-1" opacity="0.5" />
            </svg>
            Add to chat
          </button>
        )}
      </div>
    );

  if (isHtml && htmlPreview && !editMode)
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-2 py-1 bg-amber-900/20 text-amber-400 text-[10px] border-b border-amber-900/30 flex-shrink-0">
          预览模式 — 相对资源路径（图片/CSS/JS）可能无法加载
        </div>
        <div className="flex-1 min-h-0 bg-cafe-surface">
          <iframe
            srcDoc={file.content}
            sandbox="allow-scripts"
            title="HTML Preview"
            className="w-full h-full border-0"
          />
        </div>
      </div>
    );

  if (isJsx && jsxPreview && !editMode)
    return <JsxPreview code={file.content} filePath={openFilePath!} worktreeId={worktreeId} />;

  return (
    <CodeViewer
      content={file.content}
      mime={file.mime}
      path={file.path}
      scrollToLine={scrollToLine}
      editable={editMode}
      onSave={onSave}
      branch={currentWorktree?.branch}
    />
  );
}
