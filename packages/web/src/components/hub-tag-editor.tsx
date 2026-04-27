'use client';

import { useMemo, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';

function normalizeTag(value: string): string {
  return value.trim();
}

function mergeTags(tags: string[], nextTag: string): string[] {
  return Array.from(new Set([...tags, nextTag]));
}

function pillClass(tone: 'purple' | 'green' | 'orange') {
  if (tone === 'green') return 'border-[#CFE5D5] bg-[#E8F5E9] text-[#4F7B50]';
  if (tone === 'orange') return 'border-[#E8C9AF] bg-[#F7EEE6] text-[#C8946B]';
  return 'border-[#D9C5EF] bg-[#F3EDFA] text-[#8B68B7]';
}

export function TagPillList({
  tags,
  emptyLabel,
  tone = 'purple',
  lockedTags = [],
  onRemove,
}: {
  tags: string[];
  emptyLabel: string;
  tone?: 'purple' | 'green' | 'orange';
  lockedTags?: string[];
  onRemove?: (tag: string) => void;
}) {
  const locked = useMemo(() => new Set(lockedTags), [lockedTags]);

  if (tags.length === 0) {
    return <span className="text-sm italic text-[#8A776B]">{emptyLabel}</span>;
  }

  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${pillClass(tone)}`}
        >
          <span>{tag}</span>
          {onRemove && !locked.has(tag) ? (
            <button
              type="button"
              aria-label={`移除 ${tag}`}
              onClick={() => onRemove(tag)}
              className="rounded-full px-1 text-[10px] leading-none opacity-70 transition hover:opacity-100"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </>
  );
}

export function TagEditor({
  tags,
  onChange,
  addLabel,
  placeholder,
  emptyLabel,
  lockedTags = [],
  tone = 'purple',
  normalize = normalizeTag,
  validate,
  minCount = 0,
}: {
  tags: string[];
  onChange: (nextTags: string[]) => void;
  addLabel: string;
  placeholder: string;
  emptyLabel: string;
  lockedTags?: string[];
  tone?: 'purple' | 'green' | 'orange';
  normalize?: (value: string) => string;
  /** Return error message if tag is invalid, null if OK. */
  validate?: (tag: string) => string | null;
  minCount?: number;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ime = useIMEGuard();

  const commit = () => {
    const nextTag = normalize(draft);
    if (!nextTag) {
      setAdding(false);
      setDraft('');
      setError(null);
      return;
    }
    const err = validate?.(nextTag) ?? null;
    if (err) {
      setError(err);
      return;
    }
    onChange(mergeTags(tags, nextTag));
    setAdding(false);
    setDraft('');
    setError(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <TagPillList
          tags={tags}
          emptyLabel={emptyLabel}
          tone={tone}
          lockedTags={lockedTags}
          onRemove={
            // Only count removable (non-locked) tags against minCount
            tags.filter((t) => !lockedTags.includes(t)).length > minCount
              ? (tag) => onChange(tags.filter((item) => item !== tag))
              : undefined
          }
        />
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${pillClass(tone)}`}
        >
          {addLabel}
        </button>
      </div>

      {adding ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(event) => {
              if (ime.isComposing()) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
            placeholder={placeholder}
            className="min-w-[220px] flex-1 rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2 text-sm text-[#2D2118] outline-none transition focus:border-[#D49266] focus:ring-2 focus:ring-[#F5D2B8]"
          />
          <button
            type="button"
            onClick={commit}
            className="rounded-full border border-[#D49266] bg-[#FFF1E3] px-3 py-1.5 text-xs font-medium text-[#9A5A2C]"
          >
            添加
          </button>
          {error && <span className="w-full text-xs text-red-500">{error}</span>}
        </div>
      ) : null}
    </div>
  );
}
