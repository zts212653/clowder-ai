'use client';
import { useRef } from 'react';
import { FileActions } from '../content-review/FileActions';
import { FileIcon } from './FileIcons';
import type { useWorkspaceListenMode } from './useWorkspaceListenMode';
import type { WorkspaceFileViewerProps } from './WorkspaceFileViewer.types';
import { WorkspaceListenActions } from './WorkspaceListenActions';
import { WorkspaceToolbarButton as ToolbarBtn } from './WorkspaceToolbarButton';

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

/** The original classic toolbar, preserved as one visual unit. */
export function ClassicWorkspaceFileChrome({
  props,
  listenMode,
}: {
  props: WorkspaceFileViewerProps;
  listenMode: ReturnType<typeof useWorkspaceListenMode>;
}) {
  const {
    file,
    openFilePath,
    openTabs,
    canEdit,
    editMode,
    isMarkdown,
    isHtml,
    isJsx,
    markdownRendered,
    htmlPreview,
    jsxPreview,
    setOpenFile,
    closeTab,
    onCloseCurrentTab,
    onToggleEdit,
    onToggleMarkdownRendered,
    onToggleHtmlPreview,
    onToggleJsxPreview,
    collaborationAvailable,
    onOpenCollaboration,
    onFocusMode,
    focusDisabled,
  } = props;
  const filename = useRef<HTMLButtonElement>(null);
  return (
    <>
      {/* Tab bar */}
      {openTabs.length > 0 && (
        <div className="flex bg-[var(--ws-editor-bg)] border-b border-[var(--ws-editor-surface)] overflow-x-auto scrollbar-none">
          {openTabs.map((tab) => (
            <button
              key={tab}
              ref={tab === openFilePath ? filename : undefined}
              type="button"
              onClick={() => setOpenFile(tab)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border-r border-[var(--ws-editor-surface)] flex-shrink-0 transition-colors ${
                tab === openFilePath
                  ? 'bg-[var(--ws-editor-surface)] text-cafe-muted'
                  : 'text-cafe-secondary hover:text-cafe-muted hover:bg-[var(--ws-editor-hover)]'
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
                aria-label={`关闭 ${tab.split('/').pop() ?? tab}`}
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div
        data-testid="workspace-file-toolbar"
        className="w-full min-w-0 overflow-x-auto overscroll-x-contain bg-[var(--ws-editor-bg)] px-3 py-1"
        role="toolbar"
        aria-label="文件操作工具栏，可横向滚动"
      >
        <div
          data-testid="workspace-file-toolbar-content"
          className="flex w-max min-w-full items-center justify-between gap-3"
        >
          <div className="flex shrink-0 items-center gap-2">
            {props.showFileQuotes && props.onBack && (
              <ToolbarBtn onClick={props.onBack} title="返回打开文件的来源">
                返回来源
              </ToolbarBtn>
            )}
            {props.onRequestModification && (
              <ToolbarBtn
                onClick={props.onRequestModification}
                disabled={props.modificationDisabled || editMode}
                title="打开此文件的修改请求"
              >
                请猫修改
              </ToolbarBtn>
            )}
            {file.size > 0 && (
              <span className="text-micro text-cafe-secondary font-mono flex-shrink-0">
                {file.size < 1024 ? `${file.size}B` : `${Math.round(file.size / 1024)}KB`}
              </span>
            )}
            {/* The way back from 文件工具 to the landing stays first: in a narrow pane the rest scrolls. */}
            {collaborationAvailable && onOpenCollaboration && (
              <ToolbarBtn
                onClick={onOpenCollaboration}
                disabled={editMode}
                title={editMode ? '请先保存或退出编辑，再进入协作批注' : '围绕这份内容保存协作批注'}
              >
                {props.collaborationLabel ?? '协作批注'}
              </ToolbarBtn>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isMarkdown && !editMode && (
              <ToolbarBtn
                active={markdownRendered}
                onClick={onToggleMarkdownRendered}
                title={markdownRendered ? '\u5207\u6362\u5230\u6E90\u7801' : '\u5207\u6362\u5230\u6E32\u67D3'}
              >
                {markdownRendered ? 'Rendered' : 'Raw'}
              </ToolbarBtn>
            )}
            {isMarkdown && markdownRendered && !editMode && (
              <WorkspaceListenActions
                active={listenMode.active}
                cache={listenMode.cache}
                hasSentences={listenMode.sentences.length > 0}
                onCancelCache={listenMode.cancelCache}
                onStartCache={listenMode.startCache}
                onStartListen={() => listenMode.start()}
              />
            )}
            {isHtml && !editMode && (
              <ToolbarBtn
                active={htmlPreview}
                onClick={onToggleHtmlPreview}
                title={htmlPreview ? '\u5207\u6362\u5230\u6E90\u7801' : '\u9884\u89C8 HTML'}
              >
                {htmlPreview ? 'Preview' : 'Code'}
              </ToolbarBtn>
            )}
            {isJsx && !editMode && (
              <ToolbarBtn
                active={jsxPreview}
                onClick={onToggleJsxPreview}
                title={jsxPreview ? '\u5207\u6362\u5230\u6E90\u7801' : '\u9884\u89C8 JSX/TSX'}
                activeClass="bg-blue-600/80 text-[var(--cafe-surface)] hover:bg-conn-blue-text"
              >
                {jsxPreview ? 'Preview' : 'Code'}
              </ToolbarBtn>
            )}
            {props.worktreeId && (
              <FileActions
                source={{ kind: 'workspace', worktreeId: props.worktreeId, path: openFilePath ?? file.path }}
                filename={openFilePath ?? file.path}
                mime={file.mime}
                byteLength={file.size}
                text={file.binary ? undefined : file.content}
                appearance="classic"
                contextRef={filename}
              />
            )}
            {canEdit && (
              <ToolbarBtn
                active={editMode}
                onClick={onToggleEdit}
                title={editMode ? '\u9000\u51FA\u7F16\u8F91' : '\u7F16\u8F91\u6587\u4EF6'}
                activeClass="bg-green-600/80 text-[var(--cafe-surface)] hover:bg-conn-green-text"
              >
                {editMode ? '\u7F16\u8F91\u4E2D' : '\u7F16\u8F91'}
              </ToolbarBtn>
            )}
            {onFocusMode && (
              <ToolbarBtn onClick={onFocusMode} title="\u4E13\u6CE8\u6A21\u5F0F" disabled={focusDisabled}>
                专注
              </ToolbarBtn>
            )}
            <button
              type="button"
              onClick={onCloseCurrentTab}
              className="w-5 h-5 flex items-center justify-center rounded text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10 transition-colors"
              title="关闭标签页"
              aria-label="关闭标签页"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
