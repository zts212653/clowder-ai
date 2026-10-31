import { z } from 'zod';
import type { VideoProjectMediaScopeV1 } from './types.js';

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !value.includes('\0'));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const projectRef = identity.refine((value) => /^video-project:[A-Za-z0-9._-]+$/.test(value));
const scopeSchema = z
  .object({
    kind: z.literal('video-project-screening'),
    ownerUserId: identity,
    projectContentRef: projectRef,
    screeningId: identity,
    input: z
      .object({ contentRef: projectRef, ownerRevision: z.number().int().positive().safe(), blobDigest: digest })
      .strict(),
    source: z
      .object({ locator: z.object({ worktreeId: identity, path: identity }).strict(), expectedSourceRevision: digest })
      .strict(),
    sourceContentRef: identity.refine((value) => value.startsWith('workspace-content:')),
    snapshotOperationId: identity,
    requestDigest: digest,
    registeredBy: z.object({ kind: z.enum(['human', 'cat']), actorId: identity }).strict(),
    registeredAt: z.string().datetime(),
  })
  .strict();

/** A separate domain scope keeps legacy publication consumers fail-closed. */
export function validateVideoProjectMediaScope(
  scope: VideoProjectMediaScopeV1 | undefined,
  input: {
    contentRef: string;
    mediaType: string;
    projectScope?: unknown;
    publicationScope?: unknown;
    sourcePublication?: unknown;
    actor?: { kind: string; actorId: string };
  },
): void {
  if (!scope) {
    if (input.contentRef.startsWith('video-project-media:')) throw new TypeError('Project media scope is required');
    return;
  }
  const parsed = scopeSchema.parse(scope);
  if (
    !input.contentRef.startsWith('video-project-media:') ||
    input.mediaType !== 'video/mp4' ||
    input.projectScope ||
    input.publicationScope ||
    input.sourcePublication ||
    parsed.projectContentRef !== parsed.input.contentRef ||
    (input.actor &&
      (input.actor.kind !== parsed.registeredBy.kind || input.actor.actorId !== parsed.registeredBy.actorId)) ||
    (parsed.registeredBy.kind === 'human' && parsed.registeredBy.actorId !== parsed.ownerUserId)
  )
    throw new TypeError('Invalid video project media scope');
}
