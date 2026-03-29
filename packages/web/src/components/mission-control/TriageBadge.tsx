'use client';

import type { SourceTag, TriageBucket } from '@cat-cafe/shared';

const BUCKET_STYLES: Record<TriageBucket, { bg: string; text: string; label: string }> = {
  build_now: { bg: 'bg-green-100', text: 'text-green-800', label: 'Build Now' },
  clarify_first: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Clarify First' },
  validate_first: { bg: 'bg-orange-100', text: 'text-orange-800', label: 'Validate First' },
  challenge: { bg: 'bg-red-100', text: 'text-red-800', label: 'Challenge' },
  later: { bg: 'bg-cafe-surface-elevated', text: 'text-cafe-secondary', label: 'Later' },
};

const SOURCE_STYLES: Record<SourceTag, { bg: string; text: string }> = {
  Q: { bg: 'bg-blue-100', text: 'text-blue-800' },
  O: { bg: 'bg-green-100', text: 'text-green-800' },
  D: { bg: 'bg-purple-100', text: 'text-purple-800' },
  R: { bg: 'bg-teal-100', text: 'text-teal-800' },
  A: { bg: 'bg-red-100', text: 'text-red-800' },
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
