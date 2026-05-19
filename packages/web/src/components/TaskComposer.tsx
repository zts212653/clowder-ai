'use client';

import { useState } from 'react';

export function TaskComposer({ threadId, onClose }: { threadId: string; onClose: () => void }) {
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
      const res = await fetch('/api/tasks', {
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
        setError('创建失败，请重试');
        return;
      }
      onClose();
    } catch {
      setError('网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-3 mb-2 p-3 bg-cafe-surface-elevated border border-cafe rounded-xl">
      <input
        type="text"
        placeholder="任务标题"
        value={title}
        onChange={(e) => setTitle(e.target.value.slice(0, 200))}
        className="w-full text-sm bg-transparent border-b border-cafe pb-2 mb-2 text-cafe-secondary placeholder:text-cafe-muted focus:outline-none focus:border-cafe-crosspost"
      />
      <textarea
        placeholder="为什么需要这个任务？（可选）"
        value={why}
        onChange={(e) => setWhy(e.target.value.slice(0, 1000))}
        rows={2}
        className="w-full text-xs bg-transparent border border-cafe rounded-lg p-2 mb-2 text-cafe-secondary placeholder:text-cafe-muted focus:outline-none focus:border-cafe-crosspost resize-none"
      />
      {error && <p className="text-xs text-cafe-accent mb-2">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-cafe-muted hover:text-cafe-secondary px-3 py-1.5 rounded-lg transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="text-xs font-semibold bg-cafe-crosspost text-white px-3 py-1.5 rounded-lg transition-colors hover:bg-cafe-crosspost/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? '创建中…' : '创建任务'}
        </button>
      </div>
    </div>
  );
}
