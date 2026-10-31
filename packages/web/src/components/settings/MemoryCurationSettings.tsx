'use client';
import Link from 'next/link';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { MemoryReadState } from '../memory/page/MemoryReadState';
import { useMemoryRead } from '../memory/page/use-memory-read';
import { SettingsResourceToggleSwitch } from '../SettingsResourceCard';

interface CurationSettings {
  enabled: boolean;
  modelLabel: string;
  systemThreadId: string;
  startedAt: number | null;
}

export function MemoryCurationSettings() {
  const read = useMemoryRead<CurationSettings>('/api/config/memory-curation');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const toggle = async () => {
    if (!read.data || saving) return;
    setSaving(true);
    setError(false);
    try {
      const response = await apiFetch('/api/config/memory-curation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !read.data.enabled }),
      });
      if (!response.ok) throw new Error('Save failed');
      read.retry();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label="记忆整理"
      className="space-y-3 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-5"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-medium">记忆整理</h3>
          <p className="mt-1 text-sm text-cafe-muted">
            攒够新内容就整理，每天兜底一次。旧对话会分批补齐概况；新对话开场时可联想相关经历。
          </p>
        </div>
        <SettingsResourceToggleSwitch
          enabled={read.data?.enabled ?? false}
          disabled={!read.data || read.loading || read.error}
          busy={saving}
          onClick={() => void toggle()}
          ariaLabel="记忆整理"
          ariaPressed={read.data?.enabled ?? false}
        />
      </div>
      <MemoryReadState loading={read.loading} error={read.error} empty={false} noun="整理设置" retry={read.retry} />
      {error && (
        <p role="alert" className="text-sm text-cafe-secondary">
          开关没有保存，请重试。
        </p>
      )}
      {read.data && !read.loading && !read.error && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-compact text-cafe-secondary">
          <span>
            {read.data.enabled ? '已开启' : '已关闭'} · {read.data.modelLabel}
          </span>
          {read.data.startedAt !== null && (
            <Link
              href={`/thread/${encodeURIComponent(read.data.systemThreadId)}`}
              className="text-cafe-accent underline"
            >
              运行记录与花费
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
