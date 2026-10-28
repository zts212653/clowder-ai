import { collectiveDocumentTargetSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

const owner = 'f290-collective-content-owner';
export const collectiveDocumentHostTargetSchema = z
  .object({
    target: collectiveDocumentTargetSchema,
    hostKey: z.string().min(1).max(4096),
  })
  .strict();
export type CollectiveDocumentHostTarget = z.infer<typeof collectiveDocumentHostTargetSchema>;
export function createCollectiveDocumentSurface(input: CollectiveDocumentHostTarget): WorkspaceSurfaceDescriptor {
  const parsed = collectiveDocumentHostTargetSchema.parse(input);
  const key = JSON.stringify(parsed);
  const identity = JSON.stringify([
    parsed.target.serviceInstanceId,
    parsed.target.collectiveId,
    parsed.target.humanId,
    parsed.target.artifactId,
    parsed.target.ownerRevision,
    parsed.target.comparisonOwnerRevision ?? null,
  ]);
  return {
    id: `collective-document:${encodeURIComponent(identity)}`,
    type: 'file',
    renderer: 'file-preview',
    title: `Collective · v${parsed.target.ownerRevision}${parsed.target.comparisonOwnerRevision ? ` / v${parsed.target.comparisonOwnerRevision}` : ''}`,
    context: 'Collective',
    objectRef: { kind: 'file', id: identity },
    ownerStateRef: { owner, key },
    resultTargetRef: { owner, key },
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolveCollectiveDocumentTarget(
  surface: WorkspaceSurfaceDescriptor,
): CollectiveDocumentHostTarget | null {
  if (
    surface.ownerStateRef.owner !== owner ||
    surface.resultTargetRef?.owner !== owner ||
    surface.resultTargetRef.key !== surface.ownerStateRef.key
  )
    return null;
  try {
    const parsed = collectiveDocumentHostTargetSchema.parse(JSON.parse(surface.ownerStateRef.key));
    const expected = createCollectiveDocumentSurface(parsed);
    return expected.id === surface.id &&
      expected.objectRef.id === surface.objectRef.id &&
      surface.type === 'file' &&
      surface.renderer === 'file-preview'
      ? parsed
      : null;
  } catch {
    return null;
  }
}
