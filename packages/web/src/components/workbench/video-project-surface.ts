import { z } from 'zod';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export const VIDEO_PROJECT_OWNER = 'f138-video-project';
const targetSchema = z
  .object({
    contentRef: z.string().regex(/^video-project:[a-f0-9]{64}$/),
    screeningId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !value.includes('\0'))
      .optional(),
    position: z
      .object({ pts: z.number().int().safe(), requestId: z.number().int().safe().nonnegative() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (target) => !target.position || Boolean(target.screeningId),
    'A marked position belongs to a fixed screening',
  );
export type VideoProjectTarget = z.infer<typeof targetSchema>;

export function createVideoProjectSurface(input: VideoProjectTarget & { title: string }): WorkspaceSurfaceDescriptor {
  const target = targetSchema.parse({
    contentRef: input.contentRef,
    ...(input.screeningId ? { screeningId: input.screeningId } : {}),
    ...(input.position ? { position: input.position } : {}),
  });
  return {
    id: `video-project:${target.contentRef}`,
    type: 'video-project',
    renderer: 'video-project-review',
    title: input.title || '审片',
    context: '审片',
    objectRef: { kind: 'video-project', id: target.contentRef },
    ownerStateRef: { owner: VIDEO_PROJECT_OWNER, key: JSON.stringify(target) },
    resultTargetRef: { owner: VIDEO_PROJECT_OWNER, key: target.contentRef },
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}

export function resolveVideoProjectTarget(surface: WorkspaceSurfaceDescriptor): VideoProjectTarget | null {
  if (
    surface.type !== 'video-project' ||
    surface.renderer !== 'video-project-review' ||
    surface.objectRef.kind !== 'video-project' ||
    surface.ownerStateRef.owner !== VIDEO_PROJECT_OWNER ||
    surface.resultTargetRef?.owner !== VIDEO_PROJECT_OWNER
  )
    return null;
  try {
    const target = targetSchema.parse(JSON.parse(surface.ownerStateRef.key));
    return surface.id === `video-project:${target.contentRef}` &&
      surface.objectRef.id === target.contentRef &&
      surface.resultTargetRef.key === target.contentRef
      ? target
      : null;
  } catch {
    return null;
  }
}
