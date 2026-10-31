import type { ContentActorV1 } from '../content-owner/types.js';

/** Supplied by an authenticated Host caller, never parsed from a project/document payload. */
export interface VideoProjectPrincipal {
  readonly userId: string;
  readonly actor: ContentActorV1;
  readonly invocationId?: string;
}

export type VideoProjectPermission = 'read' | 'write';
export type AuthorizeVideoProjectCat = (input: {
  readonly principal: VideoProjectPrincipal;
  readonly contentRef: string;
  readonly permission: VideoProjectPermission;
}) => Promise<void>;

export class VideoProjectAccessError extends Error {
  readonly code = 'access_denied';
}

export class VideoProjectAccess {
  constructor(
    readonly ownerUserId: string,
    private readonly authorizeCat?: AuthorizeVideoProjectCat,
  ) {}

  async assert(
    principal: VideoProjectPrincipal,
    contentRef: string,
    permission: VideoProjectPermission,
  ): Promise<void> {
    if (principal.userId !== this.ownerUserId || !principal.actor.actorId || principal.actor.actorId.length > 256)
      throw new VideoProjectAccessError('Video project access denied');
    if (principal.actor.kind === 'human') {
      if (principal.actor.actorId !== principal.userId || principal.invocationId !== undefined)
        throw new VideoProjectAccessError('Video project access denied: Human identity mismatch');
      return;
    }
    if (principal.actor.kind !== 'cat' || !principal.invocationId || !this.authorizeCat)
      throw new VideoProjectAccessError('Video project access denied: Cat authorization required');
    await this.authorizeCat({ principal, contentRef, permission });
  }
}
