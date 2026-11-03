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
  matterId,
}: {
  tab: MemoryPageTab;
  from: string | null;
  profileSource?: ProfileSourceTarget;
  initialQuery?: string;
  findSessionId?: string | null;
  matterId?: string;
}) {
  const presentation = useShellPresentation();
  return presentation === 'v2' || profileSource || matterId ? (
    <MemoryPagePreview
      tab={tab}
      shell={presentation}
      basePath="/memory"
      from={from}
      profileSource={profileSource}
      initialQuery={initialQuery}
      findSessionId={findSessionId}
      matterId={matterId}
    />
  ) : (
    <MemoryHub activeTab="feed" initialReferrerThread={from} />
  );
}
