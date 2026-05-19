'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface SkillPreviewModalProps {
  skillId: string;
  skillName: string;
  description?: string;
  triggers?: string[];
  category?: string;
  projectPath?: string | null;
  onClose: () => void;
}

export function SkillPreviewModal({
  skillId,
  skillName,
  description,
  triggers,
  category,
  projectPath,
  onClose,
}: SkillPreviewModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [skillPath, setSkillPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllTriggers, setShowAllTriggers] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    setContent(null);
    setSkillPath(null);

    (async () => {
      try {
        const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
        const res = await apiFetch(`/api/rules/skill/${encodeURIComponent(skillId)}${query}`);
        if (id !== reqRef.current) return;
        if (!res.ok) {
          setError(res.status === 404 ? 'SKILL.md 不存在' : '加载失败');
          return;
        }
        const data = (await res.json()) as { content: string; path?: string };
        if (id !== reqRef.current) return;
        setContent(data.content);
        if (data.path) setSkillPath(data.path);
      } catch {
        if (id !== reqRef.current) return;
        setError('网络错误');
      } finally {
        if (id === reqRef.current) setLoading(false);
      }
    })();

    return () => {
      reqRef.current = id + 1;
    };
  }, [skillId, projectPath]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const triggerList = triggers?.filter(Boolean) ?? [];
  const visibleTriggers = showAllTriggers ? triggerList : triggerList.slice(0, 6);
  const hiddenTriggerCount = showAllTriggers ? 0 : Math.max(triggerList.length - 6, 0);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-preview-title"
        className="skill-preview-modal relative flex max-h-[calc(100vh-32px)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-[14px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg font-bold text-[var(--console-modal-title)]">
            ✎
          </div>
          <h2 id="skill-preview-title" className="min-w-0 flex-1 text-xl font-extrabold text-cafe">
            {skillName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
          >
            ✕
          </button>
        </div>

        {description && <p className="mt-3 text-compact leading-[1.4] text-cafe-secondary">{description}</p>}
        {category && (
          <div className="mt-2 flex">
            <span className="rounded-xl bg-[var(--console-panel-bg)] px-2.5 py-1 text-label font-bold text-cafe-muted">
              {category}
            </span>
          </div>
        )}
        {skillPath && (
          <p className="mt-1.5 truncate text-xs font-mono text-cafe-muted" title={skillPath}>
            {skillPath}
          </p>
        )}

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {triggerList.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {visibleTriggers.map((trigger) => (
                <span
                  key={trigger}
                  className="rounded-xl bg-[var(--console-panel-bg)] px-2.5 py-1 text-xs font-bold text-[var(--console-modal-title)]"
                >
                  {trigger}
                </span>
              ))}
              {hiddenTriggerCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllTriggers(true)}
                  className="rounded-xl bg-[var(--console-panel-bg)] px-2.5 py-1 text-xs font-bold text-cafe-muted transition-colors hover:text-cafe"
                >
                  +{hiddenTriggerCount}
                </button>
              )}
            </div>
          )}

          {content && (
            <div className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
              <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-cafe-secondary">
                {content}
              </pre>
            </div>
          )}
          {loading && <p className="text-xs text-cafe-muted">加载中...</p>}
          {error && <p className="text-xs font-semibold text-conn-red-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}
