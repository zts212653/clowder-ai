'use client';

import type { TaskItem } from '@cat-cafe/shared';
import { useId, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from './shell/shell-copy';
import { useShellPresentation } from './shell/shell-presentation';
import { yarnBallCopy } from './yarn-ball/yarn-ball.shell-copy';

const TASK_TITLE_MAX_LENGTH = 200;
const TASK_WHY_MAX_LENGTH = 1000;

export function TaskComposer({
  threadId,
  onClose,
  onCreated,
}: {
  threadId: string;
  onClose: () => void;
  onCreated?: (task: TaskItem) => void;
}) {
  const v2 = useShellPresentation() === 'v2';
  const t = useShellCopy(yarnBallCopy);
  const titleLimitId = useId();
  const whyLimitId = useId();
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = title.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await (v2 ? apiFetch : fetch)('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          title: title.trim(),
          why: why.trim() || undefined,
          createdBy: 'user',
        }),
      });
      if (!res.ok) {
        setError(v2 ? t.createError : '创建失败，请重试');
        return;
      }
      if (onCreated) onCreated(await res.json());
      onClose();
    } catch {
      setError(v2 ? t.networkError : '网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-3 mb-2 p-3 bg-cafe-surface-elevated border border-cafe rounded-xl">
      <input
        type="text"
        placeholder={v2 ? t.taskTitle : '任务标题'}
        aria-label={v2 ? t.taskTitle : '任务标题'}
        value={title}
        maxLength={TASK_TITLE_MAX_LENGTH}
        aria-describedby={titleLimitId}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full text-sm bg-transparent border-b border-cafe pb-2 text-cafe-secondary placeholder:text-cafe-muted focus:outline-none focus:border-cafe-crosspost"
      />
      <p id={titleLimitId} className="mb-2 mt-1 text-right text-micro text-cafe-muted">
        {v2 ? t.titleLimit(title.length, TASK_TITLE_MAX_LENGTH) : `标题 ${title.length} / ${TASK_TITLE_MAX_LENGTH}`}
      </p>
      <textarea
        placeholder={v2 ? t.reason : '为什么需要这个任务？（可选）'}
        aria-label={v2 ? t.reason : '为什么需要这个任务？（可选）'}
        value={why}
        maxLength={TASK_WHY_MAX_LENGTH}
        aria-describedby={whyLimitId}
        onChange={(e) => setWhy(e.target.value)}
        rows={2}
        className="w-full text-xs bg-transparent border border-cafe rounded-lg p-2 text-cafe-secondary placeholder:text-cafe-muted focus:outline-none focus:border-cafe-crosspost resize-none"
      />
      <p id={whyLimitId} className="mb-2 mt-1 text-right text-micro text-cafe-muted">
        {v2 ? t.reasonLimit(why.length, TASK_WHY_MAX_LENGTH) : `说明 ${why.length} / ${TASK_WHY_MAX_LENGTH}`}
      </p>
      {error && <p className="text-xs text-cafe-accent mb-2">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-cafe-muted hover:text-cafe-secondary px-3 py-1.5 rounded-lg transition-colors"
        >
          {v2 ? t.cancel : '取消'}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="text-xs font-semibold bg-cafe-crosspost text-[var(--cafe-surface)] px-3 py-1.5 rounded-lg transition-colors hover:bg-cafe-crosspost/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? (v2 ? t.creating : '创建中…') : v2 ? t.create : '创建任务'}
        </button>
      </div>
    </div>
  );
}
