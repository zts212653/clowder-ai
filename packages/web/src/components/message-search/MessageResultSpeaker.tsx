'use client';

import { useCatData } from '@/hooks/useCatData';
import { CatNameplate } from '../CatNameplate';

/** Read the same already-loaded registry as chat; a search hit never creates a member identity. */
export function MessageResultSpeaker({ speaker, label }: { speaker: string; label: string }) {
  const { getCatById } = useCatData({ fetch: false });
  if (speaker === 'system' || speaker === 'connector')
    return <span className="font-medium text-cafe-secondary">{label}</span>;
  if (speaker === 'user') {
    return (
      <span
        data-testid="message-result-human-nameplate"
        className="inline-flex h-[26px] min-w-0 items-center rounded-t-lg px-2 text-compact font-semibold"
        style={{
          backgroundImage: 'linear-gradient(to bottom, var(--color-cocreator-surface), transparent)',
          color: 'var(--color-cocreator-text)',
        }}
      >
        {label}
      </span>
    );
  }
  return getCatById(speaker) ? (
    <CatNameplate catId={speaker} name={label} />
  ) : (
    <span className="font-medium text-cafe-secondary">{label}</span>
  );
}
