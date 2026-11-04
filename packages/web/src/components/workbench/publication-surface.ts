import { type MessageMediaPublicationSource, messageMediaPublicationSourceSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export const htmlWorkSourceThreadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim() && !value.includes('\0'));

export const publicationContentRefSchema = z.string().regex(/^(?:prepared-media|work):[a-f0-9]{64}$/);
const coordinate = z
  .object({
    contentRef: publicationContentRefSchema,
    ownerRevision: z.number().int().positive().safe(),
    /**
     * The review a Host receipt is committed to. A work can be a round of several reviews and the generic entry remembers
     * or asks which one; a target that names its review is entered in that review or not at all. Absent for every plain
     * open, so a descriptor saved before this field existed still reads exactly as it did.
     */
    reviewId: z
      .string()
      .regex(/^review-[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type PublicationTarget = z.infer<typeof coordinate>;

/**
 * The coordinate as a publication this surface can open, or null when it names something else. The constructor below
 * throws on a malformed one (it is for descriptors this shell mints itself); a caller holding coordinates the owner
 * sent asks here first, so a shape it cannot open is reported instead of thrown into the Workspace.
 */
export function parsePublicationTarget(input: {
  contentRef: string;
  ownerRevision: number;
  reviewId?: string;
}): PublicationTarget | null {
  const parsed = coordinate.safeParse(coordinateInput(input));
  return parsed.success ? parsed.data : null;
}

/** Only what names the publication: a stray field on a caller's object is never carried into the descriptor. */
function coordinateInput(input: { contentRef: string; ownerRevision: number; reviewId?: string | undefined }) {
  return {
    contentRef: input.contentRef,
    ownerRevision: input.ownerRevision,
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
  };
}

export function createPublicationSurface(
  input: PublicationTarget & {
    title: string;
    navigationOrigin?: WorkspaceFileNavigationOrigin;
    messagePublicationSource?: MessageMediaPublicationSource;
    htmlWorkSourceThreadId?: string;
  },
): WorkspaceSurfaceDescriptor {
  const target = coordinate.parse(coordinateInput(input));
  const sourceThread =
    input.htmlWorkSourceThreadId === undefined
      ? undefined
      : htmlWorkSourceThreadIdSchema.parse(input.htmlWorkSourceThreadId);
  if (sourceThread && !target.contentRef.startsWith('work:'))
    throw new Error('Work context requires its original Work reference');
  return {
    id: `publication:${target.contentRef}`,
    type: 'artifact',
    renderer: 'artifact-view',
    title: input.title || '作品',
    context: `作品 · 版本 ${target.ownerRevision}`,
    objectRef: { kind: 'artifact', id: target.contentRef },
    ownerStateRef: { owner: 'f138-publication', key: JSON.stringify(target) },
    resultTargetRef: { owner: 'f138-publication', key: target.contentRef },
    ...(sourceThread ? { htmlWorkSourceThreadId: sourceThread } : {}),
    ...(input.navigationOrigin ? { navigationOrigin: input.navigationOrigin } : {}),
    ...(input.messagePublicationSource
      ? { messagePublicationSource: messageMediaPublicationSourceSchema.parse(input.messagePublicationSource) }
      : {}),
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolvePublicationTarget(surface: WorkspaceSurfaceDescriptor): PublicationTarget | null {
  if (
    surface.type !== 'artifact' ||
    surface.renderer !== 'artifact-view' ||
    surface.ownerStateRef.owner !== 'f138-publication' ||
    surface.objectRef.kind !== 'artifact'
  )
    return null;
  try {
    const target = coordinate.parse(JSON.parse(surface.ownerStateRef.key));
    if (
      surface.id !== `publication:${target.contentRef}` ||
      surface.objectRef.id !== target.contentRef ||
      surface.resultTargetRef?.owner !== 'f138-publication' ||
      surface.resultTargetRef.key !== target.contentRef
    )
      return null;
    return target;
  } catch {
    return null;
  }
}
