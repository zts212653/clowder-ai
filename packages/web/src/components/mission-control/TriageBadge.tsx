'use client';

import type { SourceTag, TriageBucket } from '@cat-cafe/shared';

const BUCKET_STYLES: Record<TriageBucket, { bg: string; text: string; label: string }> = {
  build_now: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: 'Build Now' },
  clarify_first: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: 'Clarify First' },
  validate_first: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: 'Validate First' },
  challenge: { bg: 'bg-conn-red-bg', text: 'text-conn-red-text', label: 'Challenge' },
  later: { bg: 'bg-cafe-surface-elevated', text: 'text-cafe-secondary', label: 'Later' },
};

const SOURCE_STYLES: Record<SourceTag, { bg: string; text: string }> = {
  Q: { bg: 'bg-[var(--color-cafe-accent)]/10', text: 'text-[var(--color-cafe-accent)]' },
  O: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  D: { bg: 'bg-conn-purple-bg', text: 'text-conn-purple-text' },
  R: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  A: { bg: 'bg-conn-red-bg', text: 'text-conn-red-text' },
};

export function BucketBadge({ bucket }: { bucket: TriageBucket }) {
  const style = BUCKET_STYLES[bucket];
  return (
    <span
      data-testid="bucket-badge"
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}
    >
      {style.label}
    </span>
  );
}

export function SourceBadge({ tag }: { tag: SourceTag }) {
  const style = SOURCE_STYLES[tag];
  return (
    <span
      data-testid="source-badge"
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${style.bg} ${style.text}`}
    >
      {tag}
    </span>
  );
}
