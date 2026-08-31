'use client';

/**
 * F257 Phase D — Create new version form (R15 P1).
 *
 * Inline form for creating a new content version:
 *   content textarea + reason input → POST /api/prompt-hooks/:hookId/versions
 *
 * Collapses to a single button when not active. Uses apiFetch for session auth.
 */

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsText } from './primitives';

export interface CreateVersionFormProps {
  hookId: string;
  onRefresh: () => void;
}

export function CreateVersionForm({ hookId, onRefresh }: CreateVersionFormProps) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="console-button-primary text-xs" onClick={() => setOpen(true)}>
        创建新版本
      </button>
    );
  }

  const handleSubmit = async () => {
    if (!content.trim() || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          reason: reason.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `创建失败 (${res.status})`);
        return;
      }
      setOpen(false);
      setContent('');
      setReason('');
      onRefresh();
    } catch {
      setError('网络错误');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    setContent('');
    setReason('');
    setError(null);
  };

  return (
    <div className="rounded-xl border border-[var(--console-border)] p-3">
      <SettingsText as="h4" variant="xs" tone="default" className="mb-2 font-semibold">
        创建新版本
      </SettingsText>
      <div className="space-y-2">
        <div>
          <label className="mb-1 block text-xs text-cafe-muted" htmlFor="cv-content">
            内容
          </label>
          <textarea
            id="cv-content"
            className="w-full rounded-lg border border-[var(--console-border)] bg-[var(--console-elevated-bg)] p-2 text-xs text-cafe focus:outline-none focus:ring-1 focus:ring-[var(--cafe-accent)]"
            rows={4}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="段内容..."
            disabled={busy}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-cafe-muted" htmlFor="cv-reason">
            操作原因（审计追踪）
          </label>
          <input
            id="cv-reason"
            type="text"
            className="w-full rounded-lg border border-[var(--console-border)] bg-[var(--console-elevated-bg)] p-2 text-xs text-cafe focus:outline-none focus:ring-1 focus:ring-[var(--cafe-accent)]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="修改原因..."
            disabled={busy}
          />
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="console-button-primary text-xs disabled:opacity-50"
          disabled={busy || !content.trim() || !reason.trim()}
          onClick={handleSubmit}
        >
          {busy ? '创建中...' : '确认创建'}
        </button>
        <button type="button" className="console-button-secondary text-xs" disabled={busy} onClick={handleCancel}>
          取消
        </button>
      </div>
      {error && (
        <SettingsText as="p" variant="xs" tone="red" className="mt-1">
          {error}
        </SettingsText>
      )}
    </div>
  );
}
