'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ImportProjectModalProps {
  onClose: () => void;
  onImported: () => void;
}

export function ImportProjectModal({ onClose, onImported }: ImportProjectModalProps) {
  const [name, setName] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [backlogPath, setBacklogPath] = useState('docs/ROADMAP.md');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim() || !sourcePath.trim()) {
      setError('项目名称和路径不能为空');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/external-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), sourcePath: sourcePath.trim(), backlogPath, description }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `创建失败: ${res.status}`);
      }
      onImported();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-backdrop)]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[0_12px_30px_rgba(43,33,26,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-bold text-cafe">导入项目</h2>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">项目名称 *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. studio-flow"
              className="console-form-input mt-1 w-full text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">项目路径 *</span>
            <input
              type="text"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="/home/user/studio-flow"
              className="console-form-input mt-1 w-full text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">Backlog 路径</span>
            <input
              type="text"
              value={backlogPath}
              onChange={(e) => setBacklogPath(e.target.value)}
              className="console-form-input mt-1 w-full text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">描述</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述"
              className="console-form-input mt-1 w-full text-sm"
            />
          </label>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="console-button-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="console-button-primary disabled:opacity-40"
          >
            {submitting ? '导入中...' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
