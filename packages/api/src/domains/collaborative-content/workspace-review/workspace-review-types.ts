import type { EvolutionMediaLocator, ImmutableMedia, WorkspaceContentActor } from '@cat-cafe/shared';

/** Caller identity and read ports carry no dependency on review implementation or source resolution. */
export interface WorkspaceReviewPrincipal {
  readonly userId: string;
  readonly actor: WorkspaceContentActor;
}

export interface EvolutionMediaReadPort {
  read(
    locator: EvolutionMediaLocator,
    principal: Pick<WorkspaceReviewPrincipal, 'userId'>,
  ): Promise<{
    bytes: Buffer;
    mime: string;
    label: string;
    media: ImmutableMedia;
  }>;
}
