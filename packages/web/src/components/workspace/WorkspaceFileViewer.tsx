'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { MarkdownContent } from '../MarkdownContent';
import { CodeViewer } from './CodeViewer';
import { FileIcon } from './FileIcons';
import { FocusModeButton } from './FocusModeButton';
import { JsxPreview } from './JsxPreview';

interface WorkspaceFileViewerProps {
  canEdit: boolean;
  closeTab: (path: string) => void;
  currentWorktree?: WorktreeEntry;
  editMode: boolean;
  file: FileData | null;
  htmlPreview: boolean;
  isHtml: boolean;
  isJsx: boolean;
  isMarkdown: boolean;
  jsxPreview: boolean;
  markdownRendered: boolean;
  onCloseCurrentTab: () => void;
  onEnterFocus?: () => void;
  onSave: (newContent: string) => Promise<void>;
  onToggleEdit: () => void;
  onToggleHtmlPreview: () => void;
  onToggleJsxPreview: () => void;
  onToggleMarkdownRendered: () => void;
  openFilePath: string | null;
  openTabs: string[];
  revealInFinder: (path: string) => void;
  saveError: string | null;
  scrollToLine: number | null;
  setOpenFile: (path: string) => void;
  worktreeId: string | null;
}

const CloseIcon = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path d="M1 1l8 8M9 1l-8 8" />
  </svg>
);

export function WorkspaceFileViewer({
  canEdit,
  closeTab,
  currentWorktree,
  editMode,
  file,
  htmlPreview,
  isHtml,
  isJsx,
  isMarkdown,
  jsxPreview,
  markdownRendered,
  onCloseCurrentTab,
  onEnterFocus,
  onSave,
  onToggleEdit,
  onToggleHtmlPreview,
  onToggleJsxPreview,
  onToggleMarkdownRendered,
  openFilePath,
  openTabs,
  revealInFinder,
  saveError,
  scrollToLine,
  setOpenFile,
  worktreeId,
}: WorkspaceFileViewerProps) {
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const [mdHasSelection, setMdHasSelection] = useState(false);
  const mdContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = mdContainerRef.current;
    if (!container) {
      setMdHasSelection(false);
      return;
    }

    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setMdHasSelection(false);
        return;
      }
      if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) {
        setMdHasSelection(false);
        return;
      }
      setMdHasSelection(!!sel.toString().trim());
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [markdownRendered, openFilePath, editMode]);

  const handleMdAddToChat = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const container = mdContainerRef.current;
    if (!container || !container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    const text = sel.toString().trim();
    if (!text || !openFilePath) return;
    const branch = currentWorktree?.branch;
    const suffix = branch ? ` (🌿 ${branch})` : '';
    const ref = `\`${openFilePath}\`${suffix}\n\`\`\`markdown\n${text}\n\`\`\``;
    setPendingChatInsert({ threadId: currentThreadId, text: ref });
  }, [currentThreadId, currentWorktree, openFilePath, setPendingChatInsert]);

  const handleCopyContent = useCallback(() => {
    if (!file?.content) {
      void navigator.clipboard.writeText(file?.content ?? '');
      return;
    }
    void navigator.clipboard.writeText(file.content);
  }, [file]);

  const handleCopyPath = useCallback(() => {
    if (!openFilePath) return;
    const abs = currentWorktree ? `${currentWorktree.root}/${openFilePath}` : openFilePath;
    void navigator.clipboard.writeText(abs);
  }, [currentWorktree, openFilePath]);

  const currentPath = openFilePath ?? file?.path ?? null;

  return (
    <div className="flex-1 flex flex-col min-h-0 animate-fade-in">
      {openTabs.length > 0 && (
        <div className="flex bg-[#1E1E24] border-b border-[#2a2a32] overflow-x-auto scrollbar-none">
          {openTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setOpenFile(tab)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono border-r border-[#2a2a32] flex-shrink-0 transition-colors ${
                tab === openFilePath
                  ? 'bg-[#2a2a32] text-gray-200'
                  : 'text-cafe-secondary hover:text-cafe-muted hover:bg-[#252530]'
              }`}
              title={tab}
            >
              <FileIcon name={tab} />
              <span className="truncate max-w-[120px]">{tab.split('/').pop()}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    closeTab(tab);
                  }
                }}
                className="ml-0.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-cafe-surface/10 transition-opacity text-cafe-secondary hover:text-cafe-muted"
                title="关闭"
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {file && (
        <>
          <div className="px-3 py-1 bg-[#1E1E24] flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {file.size > 0 && (
                <span className="text-[9px] text-cafe-secondary font-mono flex-shrink-0">
                  {file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {isMarkdown && !editMode && (
                <button
                  type="button"
                  onClick={onToggleMarkdownRendered}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    markdownRendered
                      ? 'bg-cocreator-primary/80 text-white hover:bg-cocreator-primary'
                      : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
                  }`}
                  title={markdownRendered ? '切换到源码' : '切换到渲染'}
                >
                  {markdownRendered ? 'Rendered' : 'Raw'}
                </button>
              )}
              {isHtml && !editMode && (
                <button
                  type="button"
                  onClick={onToggleHtmlPreview}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    htmlPreview
                      ? 'bg-cocreator-primary/80 text-white hover:bg-cocreator-primary'
                      : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
                  }`}
                  title={htmlPreview ? '切换到源码' : '预览 HTML'}
                >
                  {htmlPreview ? 'Preview' : 'Code'}
                </button>
              )}
              {isJsx && !editMode && (
                <button
                  type="button"
                  onClick={onToggleJsxPreview}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    jsxPreview
                      ? 'bg-blue-600/80 text-white hover:bg-blue-500'
                      : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
                  }`}
                  title={jsxPreview ? '切换到源码' : '预览 JSX/TSX'}
                >
                  {jsxPreview ? 'Preview' : 'Code'}
                </button>
              )}

              {file.content != null && (
                <button
                  type="button"
                  onClick={handleCopyContent}
                  className="px-2 py-0.5 rounded text-[10px] font-medium text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10 transition-colors"
                  title={file.truncated ? '复制已加载内容（文件已截断，非完整全文）' : '复制文件全文'}
                >
                  {file.truncated ? 'Copy…' : 'Copy'}
                </button>
              )}
              <button
                type="button"
                onClick={handleCopyPath}
                className="px-2 py-0.5 rounded text-[10px] font-medium text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10 transition-colors"
                title="复制绝对路径"
              >
                Path
              </button>
              <button
                type="button"
                onClick={() => {
                  if (currentPath) void revealInFinder(currentPath);
                }}
                className="px-2 py-0.5 rounded text-[10px] font-medium text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10 transition-colors"
                title="在 Finder 中显示"
              >
                Finder
              </button>
              {onEnterFocus && <FocusModeButton label="专注预览" onClick={onEnterFocus} />}
              {canEdit && (
                <button
                  type="button"
                  onClick={onToggleEdit}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    editMode
                      ? 'bg-green-600/80 text-white hover:bg-green-500'
                      : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
                  }`}
                  title={editMode ? '退出编辑' : '编辑文件'}
                >
                  {editMode ? '编辑中' : '编辑'}
                </button>
              )}
              <button
                type="button"
                onClick={onCloseCurrentTab}
                className="w-5 h-5 flex items-center justify-center rounded text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10 transition-colors"
                title="关闭标签页"
              >
                <CloseIcon />
              </button>
            </div>
          </div>
          {saveError && (
            <div className="px-3 py-1.5 text-[10px] text-red-400 bg-red-900/20 border-b border-red-900/30">
              {saveError}
            </div>
          )}
          {file.binary ? (
            file.mime.startsWith('image/') ? (
              <div className="flex-1 flex items-center justify-center bg-[#1E1E24] p-4 overflow-auto">
                <img
                  src={`${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(file.path)}`}
                  alt={file.path}
                  className="max-w-full max-h-full object-contain rounded"
                />
              </div>
            ) : file.mime.startsWith('audio/') ? (
              <div className="flex-1 flex flex-col items-center justify-center bg-[#1E1E24] p-6 gap-3">
                <span className="text-3xl">🎵</span>
                <audio
                  controls
                  src={`${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(file.path)}`}
                  className="w-full max-w-md"
                >
                  浏览器不支持音频播放
                </audio>
                <p className="text-[10px] text-cafe-secondary">
                  {file.mime} · {Math.round(file.size / 1024)}KB
                </p>
              </div>
            ) : file.mime.startsWith('video/') ? (
              <div className="flex-1 flex items-center justify-center bg-[#1E1E24] p-4 overflow-auto">
                <video
                  controls
                  src={`${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(file.path)}`}
                  className="max-w-full max-h-full rounded"
                >
                  浏览器不支持视频播放
                </video>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 bg-[#1E1E24] text-cafe-secondary text-xs">
                <span className="text-2xl mb-2">📄</span>
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
            )
          ) : isMarkdown && markdownRendered && !editMode ? (
            <div className="relative flex-1 min-h-0">
              <div className="h-full overflow-auto bg-cafe-white p-4" ref={mdContainerRef}>
                <MarkdownContent
                  content={file.content}
                  disableCommandPrefix
                  basePath={file.path.split('/').slice(0, -1).join('/') || undefined}
                  worktreeId={worktreeId ?? undefined}
                />
              </div>
              {mdHasSelection && (
                <button
                  type="button"
                  onClick={handleMdAddToChat}
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
          ) : isHtml && htmlPreview && !editMode ? (
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
          ) : isJsx && jsxPreview && !editMode ? (
            <JsxPreview code={file.content} filePath={file.path} worktreeId={worktreeId} />
          ) : (
            <CodeViewer
              content={file.content}
              mime={file.mime}
              path={file.path}
              scrollToLine={scrollToLine}
              editable={editMode}
              onSave={onSave}
              branch={currentWorktree?.branch}
            />
          )}
          {file.truncated && (
            <div className="px-3 py-1.5 text-[10px] text-amber-400 bg-[#1E1E24] border-t border-amber-900/30">
              文件已截断 (超过 1MB)
            </div>
          )}
        </>
      )}
    </div>
  );
}
