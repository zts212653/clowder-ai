import {
  type EvolutionMediaLocator,
  evolutionMediaLocatorSchema,
  exactAssetVersionRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { explorationReadingSchema } from '@/components/capability-evolution/exploration/exploration-reading';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export const evolutionMediaReadingSchema = z
  .object({
    selectedVersionRef: exactAssetVersionRefV1Schema.optional(),
    exploration: explorationReadingSchema.omit({ draft: true }),
    view: z.enum(['history', 'judgment']),
    scroll: z.object({
      detail: z.number().nonnegative(),
      judgment: z.number().nonnegative(),
      history: z.number().nonnegative(),
    }),
  })
  .strict();
export function evolutionMediaObjectKey(locator: EvolutionMediaLocator) {
  return JSON.stringify([
    locator.programId,
    refIdentity(locator.experimentRef),
    refIdentity(locator.recordRef),
    refIdentity(locator.mediaRef),
  ]);
}
export function createEvolutionMediaSurface(
  locator: EvolutionMediaLocator,
  title: string,
  navigationOrigin?: WorkspaceFileNavigationOrigin,
): WorkspaceSurfaceDescriptor {
  const target = evolutionMediaLocatorSchema.parse(locator),
    key = evolutionMediaObjectKey(target);
  return {
    id: 'evolution-media:' + key,
    type: 'artifact',
    renderer: 'artifact-view',
    title,
    context: '实验原件 · 共同讨论',
    objectRef: { kind: 'artifact', id: key },
    ownerStateRef: { owner: 'f311-media', key: JSON.stringify(target) },
    resultTargetRef: { owner: 'f311-media', key },
    ...(navigationOrigin ? { navigationOrigin } : {}),
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolveEvolutionMediaTarget(surface: WorkspaceSurfaceDescriptor): EvolutionMediaLocator | null {
  if (
    surface.type !== 'artifact' ||
    surface.renderer !== 'artifact-view' ||
    surface.ownerStateRef.owner !== 'f311-media'
  )
    return null;
  try {
    const locator = evolutionMediaLocatorSchema.parse(JSON.parse(surface.ownerStateRef.key)),
      key = evolutionMediaObjectKey(locator);
    if (
      surface.id !== 'evolution-media:' + key ||
      surface.objectRef.kind !== 'artifact' ||
      surface.objectRef.id !== key ||
      surface.resultTargetRef?.owner !== 'f311-media' ||
      surface.resultTargetRef.key !== key
    )
      return null;
    return locator;
  } catch {
    return null;
  }
}
export function validEvolutionMediaOrigin(
  origin: Extract<WorkspaceFileNavigationOrigin, { kind: 'evolution-media' }>,
): boolean {
  try {
    return (
      /^evolution-program:[a-f0-9]{32}$/.test(origin.programId) &&
      evolutionMediaReadingSchema.safeParse(JSON.parse(origin.readingState)).success
    );
  } catch {
    return false;
  }
}
