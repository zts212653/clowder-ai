import { type VideoProjectScreening, videoProjectScreeningSchema } from '@cat-cafe/shared';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import {
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
  type ProjectContentOwnerService,
} from '../content-owner/service.js';
import { projectValueDigest, sameProjectValue } from './document-mutations.js';
import { freezeProjectScreeningMedia } from './screening-media.js';
import {
  type AppendVideoProjectScreening,
  type AuthorizeScreeningCatSource,
  type RegisterVideoProjectScreeningInput,
  VideoProjectScreeningError,
} from './screening-types.js';
import type { VideoProjectReadPort, VideoProjectSnapshot } from './types.js';

export type { AppendVideoProjectScreening, RegisterVideoProjectScreeningInput } from './screening-types.js';
export { VideoProjectScreeningError } from './screening-types.js';

/** F138 media is frozen once; all reads/streams recheck the project's current authority. */
export class VideoProjectScreeningService {
  constructor(
    private readonly deps: {
      owner: ProjectContentOwnerService;
      projects: VideoProjectReadPort;
      workspace: Pick<WorkspaceContentSourceService, 'describe' | 'openMedia'>;
      appendScreening: AppendVideoProjectScreening;
      authorizeCatSource?: AuthorizeScreeningCatSource;
      now?: () => string;
    },
  ) {}

  async register(input: RegisterVideoProjectScreeningInput) {
    assertRegistration(input);
    await this.deps.projects.authorize({ ...input, permission: 'write' });
    if (input.principal.actor.kind === 'cat') {
      if (!this.deps.authorizeCatSource) throw new VideoProjectScreeningError('access_denied');
      await this.deps.authorizeCatSource(input);
    }
    const requestDigest = registrationDigest(input);
    const replay = await this.deps.projects.operationReceipt(input);
    if (replay) {
      const saved = await this.deps.projects.load({ ...input, ownerRevision: replay.ownerRevision });
      const screening = saved.document.screenings?.find((candidate) => candidate.operationId === input.operationId);
      if (
        replay.operationContext?.kind !== 'video-project:screening' ||
        replay.operationContext.requestDigest !== requestDigest ||
        replay.previousOwnerRevision !== input.expectedOwnerRevision ||
        !sameProjectValue(replay.actor, input.principal.actor) ||
        !screening
      )
        throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
      return { receipt: replay, screening };
    }
    const head = await this.deps.projects.load(input);
    if (head.document.archivedAt) throw new VideoProjectScreeningError('archived');
    if (head.document.screenings?.some((candidate) => candidate.id === input.id))
      throw new VideoProjectScreeningError('invalid_screening');
    const frozen = await this.deps.projects.load({ ...input, ownerRevision: input.input.ownerRevision });
    if (input.input.contentRef !== input.contentRef || frozen.blobDigest !== input.input.blobDigest)
      throw new VideoProjectScreeningError('input_changed');
    const media = await freezeProjectScreeningMedia(this.deps, input, requestDigest);
    const screening = videoProjectScreeningSchema.parse({
      id: input.id,
      title: input.title,
      input: input.input,
      media: {
        contentRef: media.contentRef,
        ownerRevision: 1,
        blobDigest: media.blobDigest,
        byteLength: media.byteLength,
        media: media.media,
      },
      mapping: input.mapping,
      actor: media.scope.registeredBy,
      at: media.scope.registeredAt,
      operationId: input.operationId,
      refs: input.refs,
    });
    assertMappingBound(screening, frozen);
    await this.deps.projects.authorize({ ...input, permission: 'write' });
    if (input.principal.actor.kind === 'cat') await this.deps.authorizeCatSource?.(input);
    const receipt = await this.deps.appendScreening({ ...input, screening, requestDigest });
    return { receipt, screening };
  }

  async descriptor(input: {
    principal: RegisterVideoProjectScreeningInput['principal'];
    contentRef: string;
    screeningId: string;
  }) {
    const snapshot = await this.deps.projects.load(input);
    if (snapshot.document.archivedAt) throw new VideoProjectScreeningError('archived');
    const screening = snapshot.document.screenings?.find((candidate) => candidate.id === input.screeningId);
    if (!screening) throw new VideoProjectScreeningError('screening_not_found');
    const frozen = await this.deps.projects.load({ ...input, ownerRevision: screening.input.ownerRevision });
    if (frozen.blobDigest !== screening.input.blobDigest) throw new VideoProjectScreeningError('input_changed');
    await this.assertMediaScope(input, screening);
    return {
      screening,
      mediaUrl: `/api/video-projects/${encodeURIComponent(input.contentRef)}/screenings/${encodeURIComponent(input.screeningId)}/media`,
    };
  }

  async open(input: {
    principal: RegisterVideoProjectScreeningInput['principal'];
    contentRef: string;
    screeningId: string;
  }) {
    const { screening } = await this.descriptor(input);
    let opened: Awaited<ReturnType<ProjectContentOwnerService['open']>>;
    try {
      opened = await this.deps.owner.open(screening.media.contentRef, screening.media.ownerRevision);
    } catch (error) {
      if (
        error instanceof ContentOwnerNotFoundError ||
        (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw new VideoProjectScreeningError('media_missing');
      throw new VideoProjectScreeningError('media_changed');
    }
    try {
      await this.descriptor(input);
      if (opened.blobDigest !== screening.media.blobDigest || opened.byteLength !== screening.media.byteLength)
        throw new VideoProjectScreeningError('media_changed');
      return opened;
    } catch (error) {
      await opened.handle.close();
      throw error;
    }
  }

  private async assertMediaScope(
    input: { principal: RegisterVideoProjectScreeningInput['principal']; contentRef: string; screeningId: string },
    screening: VideoProjectScreening,
  ) {
    const actual = await this.deps.owner.describe(screening.media.contentRef, screening.media.ownerRevision);
    const scope = actual.projectMediaScope;
    if (
      !scope ||
      scope.ownerUserId !== input.principal.userId ||
      scope.projectContentRef !== input.contentRef ||
      scope.screeningId !== input.screeningId ||
      !sameProjectValue(scope.input, screening.input) ||
      actual.blobDigest !== screening.media.blobDigest ||
      actual.mediaType !== 'video/mp4'
    )
      throw new VideoProjectScreeningError('access_denied');
    await this.deps.projects.authorize({ ...input, permission: 'read' });
  }
}

function assertRegistration(input: RegisterVideoProjectScreeningInput) {
  if (
    !input ||
    !Number.isSafeInteger(input.expectedOwnerRevision) ||
    input.expectedOwnerRevision < 1 ||
    !input.input ||
    input.input.ownerRevision > input.expectedOwnerRevision ||
    !/^sha256:[a-f0-9]{64}$/.test(input.input.blobDigest) ||
    !input.source ||
    !/^sha256:[a-f0-9]{64}$/.test(input.source.expectedSourceRevision) ||
    [input.operationId, input.id, input.title, input.contentRef].some(
      (value) =>
        typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value || value.includes('\0'),
    ) ||
    !Array.isArray(input.refs) ||
    !input.refs.length ||
    input.refs.some((value) => typeof value !== 'string' || !value || value.length > 4096)
  )
    throw new VideoProjectScreeningError('invalid_screening');
}

function registrationDigest(input: RegisterVideoProjectScreeningInput): `sha256:${string}` {
  return projectValueDigest({
    contentRef: input.contentRef,
    expectedOwnerRevision: input.expectedOwnerRevision,
    operationId: input.operationId,
    id: input.id,
    title: input.title,
    input: input.input,
    source: input.source,
    mapping: input.mapping,
    refs: input.refs,
    actor: input.principal.actor,
  });
}

function assertMappingBound(screening: VideoProjectScreening, input: VideoProjectSnapshot) {
  const { frame, segments } = screening.mapping;
  const media = screening.media.media;
  if (
    media.kind !== 'video' ||
    frame.displayWidth !== media.width ||
    frame.displayHeight !== media.height ||
    frame.canvasWidth !== input.document.timeline.width ||
    frame.canvasHeight !== input.document.timeline.height ||
    segments.some(
      (segment) =>
        segment.mediaStartPts < media.startTick ||
        segment.mediaEndPts > media.startTick + media.durationTicks ||
        segment.projectEndTick > input.document.timeline.durationTicks,
    )
  )
    throw new VideoProjectScreeningError('invalid_screening');
}
