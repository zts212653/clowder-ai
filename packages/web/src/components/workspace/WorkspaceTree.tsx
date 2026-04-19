import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '@/hooks/useWorkspace';
import { DirIcon, FileIcon } from './FileIcons';
import { InlineTreeInput } from './InlineTreeInput';

// --- Inline SVG icons (10x10) ---
const CiteIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M1.5 2.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H5L2.5 11.5V9h-1a1 1 0 0 1-1-1V2.5Z" />
    <path d="M13.5 5v4a1 1 0 0 1-1 1H12v2.5L9.5 10H7a1 1 0 0 1-1-1" opacity="0.5" />
  </svg>
);
const PlusFileIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M11.5 1H4.5C3.7 1 3 1.7 3 2.5v11c0 .8.7 1.5 1.5 1.5h7c.8 0 1.5-.7 1.5-1.5v-11c0-.8-.7-1.5-1.5-1.5zM8.5 9H8v1.5a.5.5 0 01-1 0V9H5.5a.5.5 0 010-1H7V6.5a.5.5 0 011 0V8h1.5a.5.5 0 010 1z" />
  </svg>
);
const PlusDirIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M14 4H7.5L6 2.5c-.1-.3-.4-.5-.7-.5H1.5C.7 2 0 2.7 0 3.5v9c0 .8.7 1.5 1.5 1.5h12.5c.8 0 1.5-.7 1.5-1.5V5.5C16 4.7 15.3 4 14.5 4zM9 10H8v1.5a.5.5 0 01-1 0V10H5.5a.5.5 0 010-1H7V7.5a.5.5 0 011 0V9h1.5a.5.5 0 010 1H9z" />
  </svg>
);
const PenIcon = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M13.2 1.9l1 1c.3.3.3.8 0 1.1l-8.4 8.4-2.8.7.7-2.8L12.1 2c.3-.3.8-.3 1.1 0z" />
  </svg>
);
const TrashIcon = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5.5 5.5a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm5 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
    <path
      fillRule="evenodd"
      d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1zM4.1 4L4 4.06V13a1 1 0 001 1h6a1 1 0 001-1V4.06L11.9 4H4.1zM7 2h2v1H7V2z"
    />
  </svg>
);

const UploadIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 1L3 6h3v5h4V6h3L8 1zM2 13h12v2H2v-2z" />
  </svg>
);
const CopyPathIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M4 1.5A1.5 1.5 0 015.5 0h5A1.5 1.5 0 0112 1.5v9a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 014 10.5v-9zM5.5 1a.5.5 0 00-.5.5v9a.5.5 0 00.5.5h5a.5.5 0 00.5-.5v-9a.5.5 0 00-.5-.5h-5z" />
    <path d="M2 4.5A1.5 1.5 0 013.5 3H4v8.5a.5.5 0 00.5.5H10v.5a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 012 12.5v-8z" />
  </svg>
);

const hoverBtn =
  'opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-cocreator-dark/40 hover:text-cocreator-primary hover:bg-cocreator-light/60 transition-all';
const hoverBtnDanger =
  'opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-cocreator-dark/40 hover:text-red-500 hover:bg-red-50 transition-all';

export interface PendingAction {
  type: 'new-file' | 'new-dir' | 'rename';
  targetPath: string; // parent dir for new-*, item path for rename
}

export interface TreeCallbacks {
  onCreateFile?: (dirPath: string, name: string) => Promise<boolean>;
  onCreateDir?: (dirPath: string, name: string) => Promise<boolean>;
  onDelete?: (path: string) => Promise<boolean>;
  onRename?: (oldPath: string, newName: string) => Promise<boolean>;
  onUpload?: (dirPath: string, files: FileList) => Promise<void>;
}

function TreeItem({
  node,
  depth,
  onSelect,
  onCite,
  expandedPaths,
  toggleExpand,
  selectedPath,
  pendingAction,
  onStartAction,
  onConfirmAction,
  onCancelAction,
  callbacks,
  onDrop,
}: {
  node: TreeNode;
  depth: number;
  onSelect: (path: string) => void;
  onCite?: (path: string) => void;
  expandedPaths: Set<string>;
  toggleExpand: (path: string) => void;
  selectedPath: string | null;
  pendingAction: PendingAction | null;
  onStartAction: (action: PendingAction) => void;
  onConfirmAction: (value: string) => void;
  onCancelAction: () => void;
  callbacks: TreeCallbacks;
  onDrop?: (dirPath: string, files: FileList) => void;
}) {
  const isDir = node.type === 'directory';
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = node.path === selectedPath;
  const isRenaming = pendingAction?.type === 'rename' && pendingAction.targetPath === node.path;
  const showInlineInput =
    pendingAction &&
    (pendingAction.type === 'new-file' || pendingAction.type === 'new-dir') &&
    pendingAction.targetPath === node.path;
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDir) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    },
    [isDir],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (isDir && e.dataTransfer.files.length > 0 && onDrop) {
        onDrop(node.path, e.dataTransfer.files);
      }
    },
    [isDir, node.path, onDrop],
  );

  if (isRenaming) {
    return (
      <InlineTreeInput
        depth={depth}
        kind={isDir ? 'directory' : 'file'}
        defaultValue={node.name}
        onConfirm={onConfirmAction}
        onCancel={onCancelAction}
      />
    );
  }

  return (
    <div className={depth > 0 ? 'animate-fade-in' : ''}>
      <div
        className={`group flex items-center relative ${dragOver ? 'bg-cocreator-light/40 ring-1 ring-cocreator-primary/40 rounded' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <button
          type="button"
          onClick={() => (isDir ? toggleExpand(node.path) : onSelect(node.path))}
          className={`flex-1 text-left py-1 text-xs flex items-center gap-1.5 rounded-md transition-colors duration-100 truncate relative ${
            isSelected
              ? 'bg-cocreator-light/60 text-cocreator-dark font-medium'
              : 'hover:bg-cocreator-bg text-cafe-black/80'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: isDir ? '52px' : '40px' }}
          title={node.path}
        >
          {depth > 0 && (
            <span className="absolute left-0 top-0 bottom-0 pointer-events-none" aria-hidden>
              {Array.from({ length: depth }, (_, i) => `${i * 16 + 14}px`).map((left) => (
                <span key={left} className="absolute top-0 bottom-0 w-px bg-cocreator-light/50" style={{ left }} />
              ))}
            </span>
          )}
          <span
            className={`w-3 flex items-center justify-center flex-shrink-0 transition-transform duration-150 ${isDir && isExpanded ? 'rotate-90' : ''}`}
          >
            {isDir && (
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                fill="currentColor"
                className="text-cocreator-dark/40"
                aria-hidden="true"
              >
                <path d="M2.5 1L6 4L2.5 7" strokeWidth="1" />
              </svg>
            )}
          </span>
          {isDir ? <DirIcon expanded={isExpanded} /> : <FileIcon name={node.name} />}
          <span className="truncate">{node.name}</span>
        </button>

        {/* Hover action buttons */}
        <div className="absolute right-1 flex items-center gap-0.5">
          {isDir && callbacks.onCreateFile && (
            <button
              type="button"
              className={hoverBtn}
              title="新建文件"
              onClick={(e) => {
                e.stopPropagation();
                if (!isExpanded) toggleExpand(node.path);
                onStartAction({ type: 'new-file', targetPath: node.path });
              }}
            >
              <PlusFileIcon />
            </button>
          )}
          {isDir && callbacks.onCreateDir && (
            <button
              type="button"
              className={hoverBtn}
              title="新建目录"
              onClick={(e) => {
                e.stopPropagation();
                if (!isExpanded) toggleExpand(node.path);
                onStartAction({ type: 'new-dir', targetPath: node.path });
              }}
            >
              <PlusDirIcon />
            </button>
          )}
          {!isDir && onCite && (
            <button
              type="button"
              className={hoverBtn}
              title="引用到聊天"
              onClick={(e) => {
                e.stopPropagation();
                onCite(node.path);
              }}
            >
              <CiteIcon />
            </button>
          )}
          <button
            type="button"
            className={hoverBtn}
            title="复制路径"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard.writeText(node.path);
            }}
          >
            <CopyPathIcon />
          </button>
          {callbacks.onRename && (
            <button
              type="button"
              className={hoverBtn}
              title="重命名"
              onClick={(e) => {
                e.stopPropagation();
                onStartAction({ type: 'rename', targetPath: node.path });
              }}
            >
              <PenIcon />
            </button>
          )}
          {callbacks.onDelete && (
            <button
              type="button"
              className={hoverBtnDanger}
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                callbacks.onDelete?.(node.path);
              }}
            >
              <TrashIcon />
            </button>
          )}
        </div>
      </div>

      {/* Inline input for new file/dir (appears at top of expanded children) */}
      {showInlineInput && (
        <InlineTreeInput
          depth={depth + 1}
          kind={pendingAction.type === 'new-dir' ? 'directory' : 'file'}
          onConfirm={onConfirmAction}
          onCancel={onCancelAction}
        />
      )}

      {isDir && isExpanded && (
        <div className="relative">
          {node.children === undefined ? (
            <div
              className="py-1 text-[10px] text-cafe-muted animate-pulse"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              加载中...
            </div>
          ) : (
            node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                onSelect={onSelect}
                onCite={onCite}
                expandedPaths={expandedPaths}
                toggleExpand={toggleExpand}
                selectedPath={selectedPath}
                pendingAction={pendingAction}
                onStartAction={onStartAction}
                onConfirmAction={onConfirmAction}
                onCancelAction={onCancelAction}
                callbacks={callbacks}
                onDrop={onDrop}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function TreeSkeleton() {
  return (
    <div className="px-3 py-2 space-y-2">
      {[120, 90, 140, 80, 110, 100, 70].map((w, idx) => (
        <div
          key={`skel-${w}`}
          className="h-4 rounded-md animate-shimmer"
          style={{
            width: `${w}px`,
            marginLeft: `${(idx % 3) * 12}px`,
            background:
              'linear-gradient(90deg, var(--color-cocreator-light) 25%, rgba(255,221,210,0.3) 50%, var(--color-cocreator-light) 75%)',
            backgroundSize: '200% 100%',
          }}
        />
      ))}
    </div>
  );
}

export function WorkspaceTree({
  tree,
  loading,
  expandedPaths,
  toggleExpand,
  onSelect,
  onCite,
  selectedPath,
  hasFile,
  basisPct,
  callbacks,
}: {
  tree: TreeNode[];
  loading: boolean;
  expandedPaths: Set<string>;
  toggleExpand: (path: string) => void;
  onSelect: (path: string) => void;
  onCite?: (path: string) => void;
  selectedPath: string | null;
  hasFile: boolean;
  basisPct?: number;
  callbacks?: TreeCallbacks;
}) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const cbs = useMemo(() => callbacks ?? {}, [callbacks]);

  const handleConfirmAction = useCallback(
    async (value: string) => {
      if (!pendingAction) return;
      let ok = false;
      if (pendingAction.type === 'new-file' && cbs.onCreateFile) {
        ok = await cbs.onCreateFile(pendingAction.targetPath, value);
      } else if (pendingAction.type === 'new-dir' && cbs.onCreateDir) {
        ok = await cbs.onCreateDir(pendingAction.targetPath, value);
      } else if (pendingAction.type === 'rename' && cbs.onRename) {
        ok = await cbs.onRename(pendingAction.targetPath, value);
      }
      if (ok) setPendingAction(null);
    },
    [pendingAction, cbs],
  );

  const handleDrop = useCallback(
    (dirPath: string, files: FileList) => {
      cbs.onUpload?.(dirPath, files);
    },
    [cbs],
  );

  const handleUploadClick = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) {
        cbs.onUpload?.('', e.target.files);
        e.target.value = '';
      }
    },
    [cbs],
  );

  return (
    <div
      className="overflow-y-auto py-1 min-h-0"
      style={
        hasFile && basisPct != null ? { flexBasis: `${basisPct}%`, flexGrow: 0, flexShrink: 0 } : { flex: '1 1 0%' }
      }
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files.length) handleDrop('', e.dataTransfer.files);
      }}
    >
      {/* Root-level toolbar */}
      {callbacks && (
        <div className="group flex items-center gap-0.5 px-3 py-1 border-b border-cocreator-light/30">
          <span className="text-[10px] text-cocreator-dark/40 flex-1 uppercase tracking-wider">Files</span>
          <button
            type="button"
            className={hoverBtn}
            title="新建文件"
            onClick={() => setPendingAction({ type: 'new-file', targetPath: '' })}
          >
            <PlusFileIcon />
          </button>
          <button
            type="button"
            className={hoverBtn}
            title="新建目录"
            onClick={() => setPendingAction({ type: 'new-dir', targetPath: '' })}
          >
            <PlusDirIcon />
          </button>
          <button type="button" className={hoverBtn} title="上传文件" onClick={handleUploadClick}>
            <UploadIcon />
          </button>
          <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadChange} />
        </div>
      )}
      {/* Root-level inline input */}
      {pendingAction &&
        pendingAction.targetPath === '' &&
        (pendingAction.type === 'new-file' || pendingAction.type === 'new-dir') && (
          <InlineTreeInput
            depth={0}
            kind={pendingAction.type === 'new-file' ? 'file' : 'directory'}
            onConfirm={handleConfirmAction}
            onCancel={() => setPendingAction(null)}
          />
        )}
      {loading && tree.length === 0 ? (
        <TreeSkeleton />
      ) : tree.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7 mb-2 text-cocreator-dark/30">
            <path d="M12 15C15 15 17.5 17 17.5 19.5C17.5 21 16 22.5 12 22.5C8 22.5 6.5 21 6.5 19.5C6.5 17 9 15 12 15Z" />
            <ellipse cx="6" cy="11.5" rx="2.5" ry="3" />
            <ellipse cx="12" cy="10" rx="3" ry="3.5" />
            <ellipse cx="18" cy="11.5" rx="2.5" ry="3" />
          </svg>
          <p className="text-xs text-cocreator-dark/50">还没有文件树</p>
          <p className="text-[10px] text-cocreator-dark/30 mt-1">选择一个 worktree 开始浏览</p>
        </div>
      ) : (
        tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            onSelect={onSelect}
            onCite={onCite}
            expandedPaths={expandedPaths}
            toggleExpand={toggleExpand}
            selectedPath={selectedPath}
            pendingAction={pendingAction}
            onStartAction={setPendingAction}
            onConfirmAction={handleConfirmAction}
            onCancelAction={() => setPendingAction(null)}
            callbacks={cbs}
            onDrop={handleDrop}
          />
        ))
      )}
    </div>
  );
}
