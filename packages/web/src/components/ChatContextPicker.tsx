'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '@/stores/chat-types';
import { type ContextFileHit, searchWorkspaceContextFiles } from './chat-context-file-search';
import {
  type ContextPickerMode,
  createFileContextAttachment,
  createThreadContextAttachment,
} from './chat-context-reference';

interface ChatContextPickerProps {
  mode: ContextPickerMode;
  threads: Thread[];
  currentThreadId?: string;
  currentFilePath: string | null;
  worktreeId: string | null;
  onChoose: (attachment: ContextAttachment) => void;
  onClose: () => void;
}

export function ChatContextPicker({
  mode,
  threads,
  currentThreadId,
  currentFilePath,
  worktreeId,
  onChoose,
  onClose,
}: ChatContextPickerProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<ContextFileHit[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const visibleThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return threads
      .filter((thread) => !thread.deletedAt && thread.id !== 'default' && thread.id !== currentThreadId)
      .filter(
        (thread) => !needle || thread.id.toLowerCase().includes(needle) || thread.title?.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 8);
  }, [currentThreadId, query, threads]);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [onClose]);

  useEffect(() => {
    if (mode === 'threads' || !worktreeId || !query.trim()) {
      setFiles([]);
      setLoadingFiles(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoadingFiles(true);
      const results = await searchWorkspaceContextFiles(worktreeId, query.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setFiles(results);
      setLoadingFiles(false);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mode, query, worktreeId]);

  const showThreads = mode !== 'files';
  const showFiles = mode !== 'threads';
  const currentFile = !query.trim() && currentFilePath ? [{ path: currentFilePath }] : [];
  const visibleFiles = query.trim() ? files : currentFile;

  return (
    <div
      ref={panelRef}
      data-testid="chat-context-picker"
      role="dialog"
      aria-label="添加上下文"
      className="absolute bottom-full left-4 mb-2 z-20 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-cafe bg-cafe-surface-elevated shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="border-b border-cafe-subtle p-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            mode === 'threads' ? '搜索 Thread' : mode === 'files' ? '搜索 Workspace 文件' : '搜索 Thread 或文件'
          }
          aria-label="搜索可添加的上下文"
          className="w-full rounded-lg border border-[var(--console-border-soft)] bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--console-input-stroke)]"
        />
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {showThreads && (
          <ContextSection title="Threads">
            {visibleThreads.map((thread) => (
              <ContextItem
                key={thread.id}
                testId={`context-thread-${thread.id}`}
                title={thread.title || '未命名 Thread'}
                detail={thread.id}
                onChoose={() => onChoose(createThreadContextAttachment(thread))}
              />
            ))}
            {visibleThreads.length === 0 && <EmptyResult text="没有匹配的 Thread" />}
          </ContextSection>
        )}
        {showFiles && (
          <ContextSection title="Files">
            {visibleFiles.map((file) => (
              <ContextItem
                key={file.path}
                testId={`context-file-${file.path}`}
                title={file.path.split('/').pop() || file.path}
                detail={file.path}
                onChoose={() => onChoose(createFileContextAttachment(file.path, worktreeId))}
              />
            ))}
            {loadingFiles && <EmptyResult text="正在搜索文件…" />}
            {!loadingFiles && visibleFiles.length === 0 && (
              <EmptyResult text={query.trim() ? '没有匹配的文件' : '输入文件名开始搜索'} />
            )}
          </ContextSection>
        )}
      </div>
      <div className="border-t border-cafe-subtle px-3 py-1.5 text-micro text-cafe-muted">
        @ 召唤猫猫 · /thread 引用对话 · /file 引用文件
      </div>
    </div>
  );
}

function ContextSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="px-3 pb-1 pt-2 text-micro font-medium uppercase tracking-wide text-cafe-muted">{title}</div>
      {children}
    </section>
  );
}

function ContextItem({
  testId,
  title,
  detail,
  onChoose,
}: {
  testId: string;
  title: string;
  detail: string;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-cafe-surface-sunken"
    >
      <svg className="h-4 w-4 shrink-0 text-cafe-accent" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M4 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2v3l4-3h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z" />
      </svg>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-cafe-secondary">{title}</span>
        <span className="block truncate font-mono text-micro text-cafe-muted">{detail}</span>
      </span>
    </button>
  );
}

function EmptyResult({ text }: { text: string }) {
  return <div className="px-3 py-2 text-xs text-cafe-muted">{text}</div>;
}
