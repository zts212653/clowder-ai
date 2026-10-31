import { createEntrustedReturnFromRef, resolveFileTarget } from './real-surface-adapters';
import { retiredWorkspaceDestination } from './retired-workspace-destinations';
import type { WorkbenchAction, WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

const RECENT_LIMIT = 3;

function validThreadId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !value.includes('\0');
}

function availableSurfaces(layout: WorkbenchLayoutState): Map<string, WorkspaceSurfaceDescriptor> {
  // Live owners win over retained closed descriptors with the same identity.
  return new Map([
    ...layout.recentlyClosed.map((surface) => [surface.id, surface] as const),
    ...(layout.sidecar ? [[layout.sidecar.id, layout.sidecar] as const] : []),
    ...layout.surfaces.map((surface) => [surface.id, surface] as const),
  ]);
}

function uniqueRecentIds(
  ids: unknown[],
  available: Map<string, WorkspaceSurfaceDescriptor>,
  live: WorkspaceSurfaceDescriptor[],
): string[] {
  const seen: WorkspaceSurfaceDescriptor[] = [];
  for (const id of ids) {
    const source = typeof id === 'string' ? available.get(id) : undefined;
    if (!source) continue;
    // Prefer the admitted live page, but also deduplicate retained closed aliases.
    // Input order preserves the newer visit without promoting it.
    const surface = live.find((candidate) => sameIdentity(candidate, source)) ?? source;
    if (!seen.some((candidate) => sameIdentity(candidate, surface))) seen.push(surface);
    if (seen.length === RECENT_LIMIT) break;
  }
  return seen.map((surface) => surface.id);
}

/** Admission has already restored descriptors; malformed index data cannot discard legal topology. */
export function restoreRecentSurfaceIds(value: unknown, layout: WorkbenchLayoutState): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const available = availableSurfaces(layout);
  const live = [...layout.surfaces, ...(layout.sidecar ? [layout.sidecar] : [])];
  return Object.fromEntries(
    Object.entries(value).flatMap(([thread, ids]) => {
      if (!validThreadId(thread) || !Array.isArray(ids)) return [];
      const retained = uniqueRecentIds(ids, available, live);
      return retained.length ? [[thread, retained]] : [];
    }),
  );
}

export function selectRecentSurfaces(
  layout: WorkbenchLayoutState,
  hostThreadId: string | undefined,
  retireLegacy = false,
): readonly WorkspaceSurfaceDescriptor[] {
  if (!validThreadId(hostThreadId)) return [];
  const available = availableSurfaces(layout);
  const index = restoreRecentSurfaceIds(layout.recentSurfaceIdsByThread, layout);
  const ids = Object.hasOwn(index, hostThreadId) ? index[hostThreadId] : [];
  return ids.flatMap((id) => {
    const surface = available.get(id);
    return surface && (!retireLegacy || !retiredWorkspaceDestination(surface)) ? [surface] : [];
  });
}

function sameIdentity(left: WorkspaceSurfaceDescriptor, right: WorkspaceSurfaceDescriptor): boolean {
  if (left.objectRef.kind !== right.objectRef.kind) return false;
  const a = resolveFileTarget(left);
  const b = resolveFileTarget(right);
  if (a || b) return !!a && !!b && a.worktreeId === b.worktreeId && a.path === b.path;
  return left.objectRef.id === right.objectRef.id;
}

function remapAcceptedIdentities(
  before: WorkbenchLayoutState,
  after: WorkbenchLayoutState,
  action: WorkbenchAction,
): Record<string, string[]> {
  const previous = availableSurfaces(before);
  const available = availableSurfaces(after);
  const remapped = new Map<string, string>();
  for (const [id, surface] of previous) {
    if (available.has(id)) continue;
    const retained = [...available.values()].find((candidate) => sameIdentity(candidate, surface));
    if (retained) remapped.set(id, retained.id);
  }
  if (action.type === 'resolve-content-surface' && previous.has(action.sourceSurfaceId)) {
    const retained = [...after.surfaces, ...(after.sidecar ? [after.sidecar] : [])].find(
      (surface) => surface.id === action.surface.id || sameIdentity(surface, action.surface),
    );
    if (retained) remapped.set(action.sourceSurfaceId, retained.id);
  }
  const index = Object.fromEntries(
    Object.entries(before.recentSurfaceIdsByThread ?? {}).map(([thread, ids]) => [
      thread,
      ids.map((id) => remapped.get(id) ?? id),
    ]),
  );
  return restoreRecentSurfaceIds(index, after);
}

function boundReturnVisitId(
  before: WorkbenchLayoutState,
  after: WorkbenchLayoutState,
  active: string,
  action: Extract<WorkbenchAction, { type: 'close-surface' | 'close-artifact-to-return' }>,
): string | null {
  if (action.entitlement.reason !== 'return-origin') return null;
  const sourceId = action.type === 'close-surface' ? action.surfaceId : action.artifactSurfaceId;
  if (before.activeSurfaceId !== sourceId) return null;
  const source = before.surfaces.find((surface) => surface.id === sourceId);
  const bound = createEntrustedReturnFromRef(source?.returnTargetRef);
  const target = after.surfaces.find((surface) => surface.id === active);
  return bound &&
    target?.resultTargetRef?.owner === bound.resultTargetRef?.owner &&
    target?.resultTargetRef?.key === bound.resultTargetRef?.key
    ? active
    : null;
}

function acceptedVisitId(
  before: WorkbenchLayoutState,
  after: WorkbenchLayoutState,
  action: WorkbenchAction,
): string | null {
  const active = after.activeSurfaceId;
  if (!active || !after.surfaces.some((surface) => surface.id === active)) return null;
  switch (action.type) {
    case 'open-surface':
    case 'open-preview-surface':
      return active;
    case 'activate-surface':
    case 'restore-surface':
    case 'promote-preview-surface':
      return action.surfaceId === active ? active : null;
    case 'promote-sidecar':
      return before.sidecar?.id === active ? active : null;
    case 'open-artifact-with-return':
      return action.artifact.id === active ? active : null;
    case 'close-artifact-to-return':
    case 'close-surface':
      // Explicit Back counts only the bound target, never ordinary close's automatic fallback.
      return boundReturnVisitId(before, after, active, action);
    default:
      return null;
  }
}

/** Update only after the canonical reducer accepts an action and chooses its actual identity. */
export function retainRecentVisits(
  before: WorkbenchLayoutState,
  after: WorkbenchLayoutState,
  action: WorkbenchAction,
): WorkbenchLayoutState {
  if (after === before) return before;
  const index = remapAcceptedIdentities(before, after, action);
  const thread = 'visitThreadId' in action ? action.visitThreadId : undefined;
  if ('entitlement' in action && action.entitlement.kind === 'user' && validThreadId(thread)) {
    const id = acceptedVisitId(before, after, action);
    if (id) {
      const previous = Object.hasOwn(index, thread) ? index[thread] : [];
      Object.defineProperty(index, thread, {
        value: [id, ...previous.filter((candidate) => candidate !== id)].slice(0, RECENT_LIMIT),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return JSON.stringify(index) === JSON.stringify(before.recentSurfaceIdsByThread ?? {})
    ? after
    : { ...after, recentSurfaceIdsByThread: index };
}
