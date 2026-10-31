'use client';
import type { ArtifactReviewActor } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useScreeningCopy } from './screening.shell-copy';

/** This owner-only review surface shares Chat's runtime member names and avatars. */
export function ReviewPerson({ actor }: { actor: ArtifactReviewActor }) {
  const { getCatById } = useCatData();
  const t = useScreeningCopy();
  const cat = actor.kind === 'cat' ? getCatById(actor.actorId) : undefined;
  return (
    <div className="inline-flex items-center gap-1.5">
      {actor.kind === 'cat' && <CatAvatar catId={actor.actorId} size={20} />}
      <span>{actor.kind === 'human' ? t.you : cat?.nickname || resolveCatDisplayName(actor.actorId, getCatById)}</span>
    </div>
  );
}
