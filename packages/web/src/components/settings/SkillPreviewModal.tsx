'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface SkillPreviewModalProps {
  skillId: string;
  skillName: string;
  description?: string;
  triggers?: string[];
  category?: string;
  onClose: () => void;
}

export function SkillPreviewModal({
  skillId,
  skillName,
  description,
  triggers,
  category,
  onClose,
}: SkillPreviewModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/rules/skill/${encodeURIComponent(skillId)}`);
        if (id !== reqRef.current) return;
        if (!res.ok) {
          setError(res.status === 404 ? 'SKILL.md 不存在' : '加载失败');
          return;
        }
        const data = (await res.json()) as { content: string };
        if (id !== reqRef.current) return;
        setContent(data.content);
      } catch {
        if (id !== reqRef.current) return;
        setError('网络错误');
      } finally {
        if (id === reqRef.current) setLoading(false);
      }
    })();
    return () => {
      reqRef.current++;
    };
  }, [skillId]);

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

  const letter = skillName.charAt(0).toUpperCase();
  const localPath = `cat-cafe-skills/${skillId}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        className="relative mx-4 w-full max-w-[600px] rounded-2xl bg-[var(--console-card-bg)] shadow-[0_24px_56px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4 p-6 pb-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--cafe-accent,#C65F3D)]/15 text-sm font-bold text-[var(--cafe-accent,#C65F3D)]">
            {letter}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-cafe">预览 Skill：{skillName}</h2>
            <p className="mt-0.5 text-xs text-cafe-secondary">
              {description || '点击 Skill 卡片打开只读预览；这里展示 SKILL.md 内容、触发条件、依赖和验证状态。'}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-[var(--console-card-soft-bg)] px-2.5 py-1 text-[10px] font-semibold text-cafe-secondary">
            只读预览
          </span>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6 space-y-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-cafe">SKILL.md 内容预览</h3>
            <div className="rounded-xl bg-[var(--console-shell-bg)] p-4">
              {loading && <p className="text-xs text-cafe-muted">加载中...</p>}
              {error && <p className="text-xs text-conn-red-text">{error}</p>}
              {content && (
                <pre className="max-h-[20rem] overflow-auto text-[12px] leading-6 text-cafe-secondary whitespace-pre-wrap">
                  {content}
                </pre>
              )}
            </div>
          </section>

          <div className="flex gap-6">
            <div className="flex-1">
              <h4 className="mb-1.5 text-xs font-semibold text-cafe-muted">触发词</h4>
              <div className="flex flex-wrap gap-1.5">
                {triggers?.length ? (
                  triggers.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-[var(--cafe-accent,#C65F3D)]/10 px-2.5 py-0.5 text-[11px] font-medium text-[var(--cafe-accent,#C65F3D)]"
                    >
                      {t}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-cafe-muted">无触发词</span>
                )}
              </div>
            </div>
            <div className="flex-1">
              <h4 className="mb-1.5 text-xs font-semibold text-cafe-muted">本地路径</h4>
              <p className="text-xs text-cafe-secondary font-mono">{localPath}</p>
            </div>
          </div>

          {category && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-cafe-muted">分类</h4>
              <p className="text-xs text-cafe-secondary">{category}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4">
          <span className="mr-auto text-[10px] text-cafe-muted">配置编辑功能开发中</span>
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-cafe-secondary hover:bg-[var(--console-card-soft-bg)] transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
