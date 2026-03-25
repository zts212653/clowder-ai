'use client';

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        className="w-full max-w-md rounded-xl border border-[#E7DAC7] bg-[#FFFDF8] p-6 shadow-lg"
      >
        <h2 className="mb-4 text-base font-bold text-[#2B2118]">导入项目</h2>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-[#6B5D4F]">项目名称 *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. studio-flow"
              className="mt-1 w-full rounded-lg border border-[#D8C6AD] bg-white px-3 py-2 text-sm text-[#2B2118] focus:border-[#8B6F47] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-[#6B5D4F]">项目路径 *</span>
            <input
              type="text"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="/home/user/studio-flow"
              className="mt-1 w-full rounded-lg border border-[#D8C6AD] bg-white px-3 py-2 text-sm text-[#2B2118] focus:border-[#8B6F47] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-[#6B5D4F]">Backlog 路径</span>
            <input
              type="text"
              value={backlogPath}
              onChange={(e) => setBacklogPath(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[#D8C6AD] bg-white px-3 py-2 text-sm text-[#2B2118] focus:border-[#8B6F47] focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-[#6B5D4F]">描述</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述"
              className="mt-1 w-full rounded-lg border border-[#D8C6AD] bg-white px-3 py-2 text-sm text-[#2B2118] focus:border-[#8B6F47] focus:outline-none"
            />
          </label>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#D8C6AD] px-4 py-1.5 text-xs font-medium text-[#7A6B5A] hover:bg-[#F7EEDB]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-lg bg-[#8B6F47] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#7A6139] disabled:opacity-40"
          >
            {submitting ? '导入中...' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
