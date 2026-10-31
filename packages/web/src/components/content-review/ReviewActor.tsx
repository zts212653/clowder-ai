'use client';
import type { ArtifactReviewActor } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveCatDisplayName } from '@/lib/cat-display-name';

export function ReviewActor({ actor, ownerUserId }: { actor: ArtifactReviewActor; ownerUserId: string }) {
  const { getCatById } = useCatData();
  const coCreator = useCoCreatorConfig();
  const humanName = actor.actorId === ownerUserId ? coCreator.name : actor.actorId;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-cafe-black"
      data-actor-kind={actor.kind}
      data-actor-id={actor.actorId}
    >
      {actor.kind === 'cat' ? (
        <CatAvatar catId={actor.actorId} size={24} />
      ) : (
        <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--color-cocreator-primary)] text-micro text-white">
          {coCreator.avatar && actor.actorId === ownerUserId ? (
            // biome-ignore lint/performance/noImgElement: shared co-creator runtime avatar.
            <img src={coCreator.avatar} alt={humanName} className="h-full w-full object-cover" />
          ) : (
            humanName.slice(0, 1)
          )}
        </span>
      )}
      <span className="truncate">
        {actor.kind === 'cat' ? resolveCatDisplayName(actor.actorId, getCatById) : humanName}
      </span>
    </span>
  );
}
