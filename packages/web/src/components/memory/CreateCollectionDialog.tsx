import React, { useState } from 'react';

const COLLECTION_KINDS = ['project', 'world', 'domain', 'research', 'global'] as const;
const SENSITIVITIES = ['public', 'internal', 'private', 'restricted'] as const;

interface DryRunResult {
  totalFiles: number;
  markdownFiles: number;
  secretFindings: number;
  safe: boolean;
}

export function CreateCollectionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<string>('domain');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [root, setRoot] = useState('');
  const [sensitivity, setSensitivity] = useState<string>('private');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);

  const canDryRun = root.trim().length > 0;
  const confirmed = dryRun !== null || !canDryRun;

  const handleDryRun = async () => {
    setDryRunLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/library/bind-dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: root.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `预扫描失败 (${res.status})`);
        return;
      }
      setDryRun(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setDryRunLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (canDryRun && !dryRun) {
      await handleDryRun();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        id: `${kind}:${name}`,
        kind,
        name,
        displayName,
        sensitivity,
      };
      if (root.trim()) body.root = root.trim();
      const res = await fetch('/api/library/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `创建失败 (${res.status})`);
        return;
      }
      const collectionId = `${kind}:${name}`;
      try {
        await fetch(`/api/library/${collectionId}/rebuild`, { method: 'POST' });
      } catch {
        /* rebuild best-effort — collection is registered, user can rebuild manually */
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-[var(--console-overlay-light)] backdrop-blur-sm flex items-center justify-center z-50"
      data-testid="create-collection-dialog"
    >
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--console-card-bg)] rounded-xl shadow-lg p-6 w-full max-w-md space-y-4"
      >
        <h3 className="font-semibold text-sm text-cafe">新建集合</h3>
        {error && <div className="text-xs text-conn-red-text bg-conn-red-bg rounded-lg p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-cafe-secondary">
            类型
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="mt-1 block w-full rounded-lg bg-[var(--console-field-bg)] pl-2 pr-6 py-1.5 text-xs text-cafe-secondary outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)]"
            >
              {COLLECTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-cafe-secondary">
            名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="finance"
              className="mt-1 block w-full appearance-none rounded-lg bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)]"
              required
            />
          </label>
        </div>
        <label className="text-xs text-cafe-secondary block">
          显示名称
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Personal Finance"
            className="mt-1 block w-full appearance-none rounded-lg bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)]"
            required
          />
        </label>
        <label className="text-xs text-cafe-secondary block">
          根路径 <span className="text-cafe-tertiary">（留空则使用托管存储）</span>
          <input
            value={root}
            onChange={(e) => {
              setRoot(e.target.value);
              setDryRun(null);
            }}
            placeholder="/home/user/docs/finance"
            className="mt-1 block w-full appearance-none rounded-lg bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)]"
          />
        </label>
        <label className="text-xs text-cafe-secondary block">
          敏感级别
          <select
            value={sensitivity}
            onChange={(e) => setSensitivity(e.target.value)}
            className="mt-1 block w-full rounded-lg bg-[var(--console-field-bg)] pl-2 pr-6 py-1.5 text-xs text-cafe-secondary outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)]"
          >
            {SENSITIVITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {dryRun && (
          <div className="text-xs rounded-lg bg-[var(--console-field-bg)] p-3 space-y-1" data-testid="dry-run-preview">
            <div className="font-medium text-cafe">扫描预览</div>
            <div className="text-cafe-secondary">
              {dryRun.totalFiles} 个文件（{dryRun.markdownFiles} 个 Markdown）
            </div>
            {dryRun.secretFindings > 0 && (
              <div className="text-conn-red-text font-medium">
                检测到 {dryRun.secretFindings} 个敏感信息 — 创建前请核查。
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-cafe-secondary rounded-lg bg-[var(--console-card-bg)] shadow-[0_1px_3px_rgba(43,33,26,0.06)] hover:bg-[var(--console-hover-bg)]"
          >
            取消
          </button>
          {canDryRun && !dryRun && (
            <button
              type="button"
              onClick={handleDryRun}
              disabled={dryRunLoading || !name || !displayName}
              className="px-3 py-1.5 text-xs text-cafe-secondary rounded-lg bg-[var(--console-card-bg)] shadow-[0_1px_3px_rgba(43,33,26,0.06)] hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
              data-testid="dry-run-btn"
            >
              {dryRunLoading ? '扫描中...' : '预览扫描'}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || !name || !displayName || (canDryRun && !confirmed)}
            className="px-3 py-1.5 text-xs text-[var(--cafe-surface)] bg-cafe-accent rounded-lg hover:bg-cafe-interactive disabled:opacity-50"
          >
            {submitting ? '创建中...' : confirmed ? '创建' : '预览并创建'}
          </button>
        </div>
      </form>
    </div>
  );
}
