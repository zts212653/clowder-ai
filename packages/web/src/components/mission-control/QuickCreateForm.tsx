'use client';

import type { BacklogPriority } from '@cat-cafe/shared';
import { useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';

interface QuickCreateFormProps {
  disabled?: boolean;
  onCreate: (payload: { title: string; summary: string; priority: BacklogPriority; tags: string[] }) => Promise<void>;
}

export function QuickCreateForm({ disabled, onCreate }: QuickCreateFormProps) {
  const ime = useIMEGuard();
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState<BacklogPriority>('p2');
  const [tagsRaw, setTagsRaw] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTitle = title.trim();
    const cleanSummary = summary.trim();
    if (!cleanTitle || !cleanSummary) return;

    await onCreate({
      title: cleanTitle,
      summary: cleanSummary,
      priority,
      tags: tagsRaw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    });

    setTitle('');
    setSummary('');
    setPriority('p2');
    setTagsRaw('');
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-12 gap-2 rounded-xl border border-[#E8DCCB] bg-cafe-surface p-3"
    >
      <label htmlFor="mc-create-title" className="col-span-3">
        <span className="sr-only">任务标题</span>
        <input
          id="mc-create-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ime.isComposing()) event.preventDefault();
          }}
          placeholder="任务标题"
          className="w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B] outline-none focus:border-[#B8946A]"
          data-testid="mc-create-title"
        />
      </label>
      <label htmlFor="mc-create-summary" className="col-span-4">
        <span className="sr-only">任务摘要</span>
        <input
          id="mc-create-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ime.isComposing()) event.preventDefault();
          }}
          placeholder="一句话描述任务价值"
          className="w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B] outline-none focus:border-[#B8946A]"
          data-testid="mc-create-summary"
        />
      </label>
      <label htmlFor="mc-create-priority" className="col-span-1">
        <span className="sr-only">优先级</span>
        <select
          id="mc-create-priority"
          value={priority}
          onChange={(event) => setPriority(event.target.value as BacklogPriority)}
          className="w-full rounded-lg border border-[#E6D7C3] bg-cafe-surface px-2 py-1.5 text-xs text-[#2C241B] outline-none focus:border-[#B8946A]"
          data-testid="mc-create-priority"
        >
          <option value="p0">P0</option>
          <option value="p1">P1</option>
          <option value="p2">P2</option>
          <option value="p3">P3</option>
        </select>
      </label>
      <label htmlFor="mc-create-tags" className="col-span-3">
        <span className="sr-only">标签</span>
        <input
          id="mc-create-tags"
          value={tagsRaw}
          onChange={(event) => setTagsRaw(event.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ime.isComposing()) event.preventDefault();
          }}
          placeholder="tags: redis,ui"
          className="w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B] outline-none focus:border-[#B8946A]"
          data-testid="mc-create-tags"
        />
      </label>
      <button
        type="submit"
        disabled={disabled}
        className="col-span-1 rounded-lg bg-[#1F1A16] px-2 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="mc-create-submit"
      >
        创建
      </button>
    </form>
  );
}
