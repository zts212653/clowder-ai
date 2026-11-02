'use client';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { MemoryHub } from '../MemoryHub';
import { MemoryPagePreview, type MemoryPageTab } from './MemoryPagePreview';
import type { ProfileSourceTarget } from './profile-source-target';

/** The existing shell preference owns presentation; the classic feed remains its original entry. */
export function MemoryEntry({
  tab,
  from,
  profileSource,
  initialQuery,
  findSessionId,
}: {
  tab: MemoryPageTab;
  from: string | null;
  profileSource?: ProfileSourceTarget;
  initialQuery?: string;
  findSessionId?: string | null;
}) {
  const presentation = useShellPresentation();
  return presentation === 'v2' || profileSource ? (
    <MemoryPagePreview
      tab={tab}
      shell={presentation}
      basePath="/memory"
      from={from}
      profileSource={profileSource}
      initialQuery={initialQuery}
      findSessionId={findSessionId}
    />
  ) : (
    <MemoryHub activeTab="feed" initialReferrerThread={from} />
  );
}
