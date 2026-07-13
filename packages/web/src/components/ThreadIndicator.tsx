'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/** Tail-preserving truncation for project chip labels.
 * The suffix usually carries the distinguishing worktree or nested directory name. */
export function tailTruncate(name: string, maxLen = 24): string {
  if (name.length <= maxLen) return name;
  return `…${name.slice(-(maxLen - 1))}`;
}

const PROJECT_PATH_COPY_KEYS = new Set(['Enter', ' ']);

/** Thread indicator: shows which thread you're currently chatting in.
 *  Double-click the title to enter inline edit mode for renaming. */
export function ThreadIndicator({ threadId }: { threadId: string }) {
  const threads = useChatStore((s) => s.threads);
  const updateThreadTitle = useChatStore((s) => s.updateThreadTitle);
  const currentThread = threads.find((t) => t.id === threadId);
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = currentThread?.title ?? '未命名对话';
  const rawPath = currentThread?.projectPath ?? '';

  // Inline title editing state
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useIMEGuard();
  // Generation counter: prevents in-flight PATCH from polluting a different thread's state
  const editGenRef = useRef(0);

  // Reset edit state when switching threads — prevents accidental cross-thread rename
  useEffect(() => {
    editGenRef.current += 1;
    setIsEditing(false);
    setIsSaving(false);
  }, [threadId]);

  // Sync draft when title changes externally
  useEffect(() => {
    if (!isEditing) setDraftTitle(title);
  }, [title, isEditing]);

  // Focus + select on enter edit mode
  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const submitRename = useCallback(async () => {
    const next = draftTitle.trim();
    if (!next || next === title) {
      setDraftTitle(title);
      setIsEditing(false);
      return;
    }
    const gen = editGenRef.current;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (res.ok) {
        const updated = await res.json();
        updateThreadTitle(threadId, updated.title ?? next);
      }
    } catch {
      // Silently ignore — title stays unchanged
    } finally {
      // Only touch state if we're still on the same thread — prevents
      // a stale PATCH callback from closing a newly-opened edit on thread B
      if (editGenRef.current === gen) {
        setIsSaving(false);
        setIsEditing(false);
      }
    }
  }, [draftTitle, title, threadId, updateThreadTitle]);

  useEffect(() => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    setCopied(false);
  }, [threadId, rawPath]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    };
  }, []);

  if (threadId === 'default') {
    return <p className="text-xs text-cafe-secondary">大厅 · Your AI team collaboration space</p>;
  }

  // 'default' is a sentinel for threads without a real projectPath — match exact value, not basename
  const rawBasename = rawPath === 'default' ? '' : (rawPath.split(/[/\\]/).pop() ?? '');
  // Map known internal repo basenames to brand name; preserve real project paths for multi-workspace
  const INTERNAL_BASENAMES = ['cat-cafe', 'cat-cafe-runtime', 'clowder-ai'];
  const brandName = process.env.NEXT_PUBLIC_BRAND_NAME ?? '';
  const projectName = INTERNAL_BASENAMES.includes(rawBasename) && brandName ? brandName : rawBasename;
  const displayName = tailTruncate(projectName);
  const copyPath = rawPath === 'default' ? '' : rawPath;
  const projectChipLabel = copied ? 'copied!' : displayName;

  const handleCopyPath = () => {
    if (!copyPath) return;
    const cb = typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
    if (!cb) return;
    if (typeof cb.writeText !== 'function') return;
    void Promise.resolve()
      .then(() => cb.writeText(copyPath))
      .then(
        () => {
          if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
          setCopied(true);
          copyResetTimerRef.current = setTimeout(() => {
            setCopied(false);
            copyResetTimerRef.current = null;
          }, 1200);
        },
        () => {},
      );
  };

  return (
    <div className="flex min-w-0 items-baseline text-xs text-cafe-secondary">
      {isEditing ? (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !ime.isComposing()) {
              e.preventDefault();
              void submitRename();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraftTitle(title);
              setIsEditing(false);
            }
          }}
          onBlur={() => void submitRename()}
          disabled={isSaving}
          maxLength={200}
          className="min-w-0 flex-1 truncate rounded border border-cafe-subtle bg-transparent px-1 py-0.5 text-xs font-medium text-cafe-secondary focus:border-cafe-accent focus:outline-none disabled:opacity-70"
        />
      ) : (
        <span
          className="truncate min-w-0 font-medium text-cafe-secondary cursor-text"
          title={`${title}\n双击编辑标题`}
          onDoubleClick={() => setIsEditing(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              setIsEditing(true);
            }
          }}
        >
          {title}
        </span>
      )}
      {projectName && !isEditing && (
        <span
          className="flex-shrink-0 max-w-[40%] sm:max-w-[200px] overflow-hidden whitespace-nowrap text-cafe-muted cursor-pointer hover:text-cafe-secondary transition-colors"
          title={copied ? '已复制!' : `点击复制: ${copyPath}`}
          aria-label={copied ? '已复制项目路径' : `点击复制项目路径: ${copyPath}`}
          onClick={handleCopyPath}
          onKeyDown={(e) => {
            if (PROJECT_PATH_COPY_KEYS.has(e.key)) {
              e.preventDefault();
              handleCopyPath();
            }
          }}
          role="button"
          tabIndex={0}
        >
          {' '}
          · {projectChipLabel}
        </span>
      )}
    </div>
  );
}
