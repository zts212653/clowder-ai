import { projectTickToMediaPts, type VideoProjectScreening, type WorkspaceContentAnnotation } from '@cat-cafe/shared';
import { tickToBrowserTime } from '../../content-review/review-geometry';
import { loadProject, type ProjectSnapshot } from './api';
import {
  findModifiedUseAppearance,
  type ModificationArtworkPair,
  modificationBasis,
  modificationInputs,
} from './modification-inputs';

export interface LoadedProjectModification {
  actor: string;
  actorKind: 'human' | 'cat';
  reason?: string;
  notChanged?: string;
  ownerRevision?: number;
  pairs: ModificationArtworkPair[];
  changes: string[];
  jump: { screeningId: string; pts: number } | null;
  jumpUnavailable: boolean;
  originalJumps: { pairId: string; screeningId: string; pts: number; seconds: number }[];
  jumpSeconds?: number;
  filmsByPair: {
    pairId: string;
    jump: { screeningId: string; pts: number } | null;
    unavailable: boolean;
    seconds?: number;
  }[];
}

export async function loadProjectModification(
  contentRef: string,
  annotation: WorkspaceContentAnnotation,
  screenings: readonly VideoProjectScreening[],
  signal: AbortSignal,
): Promise<LoadedProjectModification> {
  const basis = modificationBasis(annotation);
  if ('kind' in basis.result)
    return {
      actor: basis.actor,
      actorKind: basis.actorKind,
      notChanged: basis.result.reason,
      pairs: [],
      changes: [],
      jump: null,
      jumpUnavailable: false,
      originalJumps: [],
      filmsByPair: [],
    };
  const result = basis.result;
  if ('contentRef' in result && result.contentRef !== contentRef) throw new Error('修改回执属于其他项目。');
  const cache = new Map<number, Promise<ProjectSnapshot>>();
  const load = (revision: number) => {
    let value = cache.get(revision);
    if (!value) {
      value = loadProject(contentRef, signal, revision);
      cache.set(revision, value);
    }
    return value;
  };
  const after = await load(result.ownerRevision);
  if ('blobDigest' in result && after.blobDigest !== result.blobDigest) throw new Error('修改回执的输入摘要不匹配。');
  const origins = await Promise.all(
    basis.anchors.map(async (anchor) => ({ anchor, snapshot: await load(anchor.baseOwnerRevision) })),
  );
  const changes = modificationInputs(origins, after, 'assetVersionRef' in result ? result.assetVersionRef : undefined);
  const found = await findModificationScreening(
    contentRef,
    result.ownerRevision,
    screenings,
    changes.uses,
    load,
    signal,
  );
  const filmsByPair = await Promise.all(
    changes.pairs.map(async (pair) => {
      const located = await findModificationScreening(
        contentRef,
        result.ownerRevision,
        screenings,
        changes.uses.filter((use) => use.kind === 'visual' && use.id === pair.visualUseId),
        load,
        signal,
      );
      return { pairId: pair.id, ...located };
    }),
  );
  return {
    actor: basis.actor,
    actorKind: basis.actorKind,
    reason: basis.reason,
    ownerRevision: result.ownerRevision,
    pairs: changes.pairs,
    changes: [...new Set(changes.uses.map((use) => use.description))],
    jump: found.jump,
    jumpUnavailable: found.unavailable,
    jumpSeconds: found.seconds,
    filmsByPair,
    originalJumps: changes.pairs.flatMap((pair) => {
      const origin = origins.find((item) => item.snapshot.ownerRevision === pair.before.ownerRevision)?.snapshot;
      if (!origin || !pair.visualUseId) return [];
      const segment = origin.document.timeline.segments.find((item) =>
        item.visuals.some(
          (visual) => visual.id === pair.visualUseId && visual.assetVersionRef === pair.before.version.id,
        ),
      );
      const visual = segment?.visuals.find((item) => item.id === pair.visualUseId);
      if (!segment || !visual) return [];
      const tick = segment.startTick + visual.startTick;
      // Prefer the actual film on which the Human opinion was made, when it contains this frozen input.
      const originals = screenings
        .slice()
        .sort(
          (left, right) =>
            Number(right.id === annotation.projectMessage?.screeningId) -
            Number(left.id === annotation.projectMessage?.screeningId),
        );
      for (const screening of originals) {
        if (
          screening.input.contentRef !== contentRef ||
          screening.input.ownerRevision !== origin.ownerRevision ||
          screening.input.blobDigest !== origin.blobDigest
        )
          continue;
        const pts = projectTickToMediaPts(screening, tick);
        if (pts !== null)
          return [
            { pairId: pair.id, screeningId: screening.id, pts, seconds: tickToBrowserTime(pts, screening.media.media) },
          ];
      }
      return [];
    }),
  };
}

async function findModificationScreening(
  contentRef: string,
  ownerRevision: number,
  screenings: readonly VideoProjectScreening[],
  uses: import('./modification-inputs').ModifiedProjectUse[],
  load: (revision: number) => Promise<ProjectSnapshot>,
  signal: AbortSignal,
) {
  let unavailable = false;
  for (const screening of screenings
    .filter((item) => item.input.ownerRevision >= ownerRevision)
    .slice()
    .sort((left, right) => left.input.ownerRevision - right.input.ownerRevision)) {
    if (screening.input.contentRef !== contentRef) continue;
    let snapshot: ProjectSnapshot;
    try {
      snapshot = await load(screening.input.ownerRevision);
    } catch {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      unavailable = true;
      continue;
    }
    if (snapshot.blobDigest !== screening.input.blobDigest) {
      unavailable = true;
      continue;
    }
    const jump = mappedModificationJump(screening, snapshot, uses);
    if (jump) return { jump, unavailable, seconds: tickToBrowserTime(jump.pts, screening.media.media) };
  }
  return { jump: null, unavailable, seconds: undefined };
}

function mappedModificationJump(
  screening: VideoProjectScreening,
  snapshot: ProjectSnapshot,
  uses: import('./modification-inputs').ModifiedProjectUse[],
) {
  for (const use of uses) {
    const tick = findModifiedUseAppearance(snapshot, use);
    const pts = tick === null ? null : projectTickToMediaPts(screening, tick);
    if (pts !== null) return { screeningId: screening.id, pts };
  }
  return null;
}
