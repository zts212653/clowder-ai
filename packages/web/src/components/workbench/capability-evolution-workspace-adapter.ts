import { REAL_SURFACE_OWNERS, SURFACE_CAPABILITIES } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export function createCapabilityEvolutionWorkspaceSurface(threadId?: string): WorkspaceSurfaceDescriptor {
  return {
    id: 'workspace:capability-evolution',
    type: 'workspace',
    renderer: 'workspace-destination',
    title: '能力进化',
    context: '让猫猫与系统持续变得更好',
    objectRef: { kind: 'workspace-destination', id: 'workspace:capability-evolution' },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.evolutionProgram, key: 'workspace' },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.evolutionProgram, key: threadId ?? 'global' },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function isCapabilityEvolutionWorkspaceSurface(surface: WorkspaceSurfaceDescriptor): boolean {
  return (
    surface.id === 'workspace:capability-evolution' &&
    surface.type === 'workspace' &&
    surface.renderer === 'workspace-destination' &&
    surface.objectRef.kind === 'workspace-destination' &&
    surface.objectRef.id === 'workspace:capability-evolution' &&
    surface.ownerStateRef.owner === REAL_SURFACE_OWNERS.evolutionProgram &&
    surface.ownerStateRef.key === 'workspace' &&
    surface.resultTargetRef?.owner === REAL_SURFACE_OWNERS.evolutionProgram &&
    surface.resultTargetRef.key.length > 0
  );
}
