import { messageMediaPublicationSourceSchema } from '@cat-cafe/shared';
import { artifactListViewSchema } from '@/components/artifacts/artifact-list-state';
import { artifactFileEntranceSchema } from './artifact-file-source';
import { resolveArtifactReviewTarget } from './artifact-review-surface';
import { resolveEvolutionMediaTarget } from './evolution-media-surface';
import { parseFileNavigationOrigin } from './file-navigation-origin';
import { resolveMessagePublicationSource } from './message-publication-surface';
import { resolvePublicationTarget } from './publication-surface';
import { createEntrustedReturnFromRef, resolveFilesTarget } from './real-surface-adapters';
import type {
  RestoreWorkbenchOptions,
  WorkbenchLayoutState,
  WorkbenchRenderer,
  WorkbenchSurfaceType,
  WorkspaceSurfaceDescriptor,
} from './workbench-contract';
import { createInitialWorkbenchState } from './workbench-initial-state';
import { workspaceRootSelectionSchema } from './workspace-root-selection';

export { migrateF284WorkspaceState } from './workbench-migrate-f284';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

const RENDERER_BY_TYPE: Record<WorkbenchSurfaceType, WorkbenchRenderer> = {
  'agent-run': 'agent-run',
  artifact: 'artifact-view',
  browser: 'browser-preview',
  code: 'code-editor',
  'content-editor': 'content-editor',
  'evolution-program': 'evolution-program',
  file: 'file-preview',
  review: 'review-summary',
  terminal: 'terminal-session',
  workspace: 'workspace-destination',
};

const OBJECT_KIND_BY_TYPE: Record<WorkbenchSurfaceType, WorkspaceSurfaceDescriptor['objectRef']['kind']> = {
  'agent-run': 'agent-run',
  artifact: 'artifact',
  browser: 'preview-session',
  code: 'file',
  'content-editor': 'content-editor-session',
  'evolution-program': 'evolution-program',
  file: 'file',
  review: 'review',
  terminal: 'terminal-session',
  workspace: 'workspace-destination',
};

function isSurfaceType(value: unknown): value is WorkbenchSurfaceType {
  return typeof value === 'string' && Object.hasOwn(RENDERER_BY_TYPE, value);
}

function parseSurface(value: unknown, legacySchema: boolean): WorkspaceSurfaceDescriptor | null {
  const surface = asRecord(value);
  const objectRef = asRecord(surface?.objectRef);
  const ownerStateRef = asRecord(surface?.ownerStateRef);
  const capabilities = asRecord(surface?.capabilities);
  if (surface === null || !isSurfaceType(surface.type)) return null;
  const type = surface.type;
  const renderer = RENDERER_BY_TYPE[type];
  const objectKind = OBJECT_KIND_BY_TYPE[type];
  if (
    !isNonEmptyString(surface.id) ||
    surface.renderer !== renderer ||
    !isNonEmptyString(surface.title) ||
    typeof surface.context !== 'string' ||
    objectRef === null ||
    objectRef.kind !== objectKind ||
    !isNonEmptyString(objectRef.id) ||
    ownerStateRef === null ||
    !isNonEmptyString(ownerStateRef.owner) ||
    !isNonEmptyString(ownerStateRef.key) ||
    capabilities === null ||
    capabilities.split !== true ||
    capabilities.closePolicy !== 'detach-host' ||
    capabilities.restorePolicy !== 'descriptor'
  ) {
    return null;
  }
  let resultTargetRef: WorkspaceSurfaceDescriptor['resultTargetRef'];
  if (surface.resultTargetRef !== undefined) {
    const candidate = asRecord(surface.resultTargetRef);
    if (candidate === null || !isNonEmptyString(candidate.owner) || !isNonEmptyString(candidate.key)) return null;
    resultTargetRef = { owner: candidate.owner, key: candidate.key };
  }
  let returnTargetRef: WorkspaceSurfaceDescriptor['returnTargetRef'];
  if (surface.returnTargetRef !== undefined) {
    const candidate = asRecord(surface.returnTargetRef);
    if (!candidate || !isNonEmptyString(candidate.owner) || !isNonEmptyString(candidate.key)) return null;
    returnTargetRef = { owner: candidate.owner, key: candidate.key };
    if (!createEntrustedReturnFromRef(returnTargetRef)) return null;
  }
  let navigationOrigin: WorkspaceSurfaceDescriptor['navigationOrigin'];
  if (surface.navigationOrigin !== undefined) {
    const parsedNavigationOrigin = parseFileNavigationOrigin(surface.navigationOrigin);
    if (parsedNavigationOrigin === null) return null;
    navigationOrigin = parsedNavigationOrigin;
  }
  let messagePublicationSource: WorkspaceSurfaceDescriptor['messagePublicationSource'];
  let artifactListView: WorkspaceSurfaceDescriptor['artifactListView'];
  if (surface.artifactListView !== undefined) {
    const parsed = artifactListViewSchema.safeParse(surface.artifactListView);
    if (!parsed.success || type !== 'workspace') return null;
    artifactListView = parsed.data;
  }
  let artifactFileSource: WorkspaceSurfaceDescriptor['artifactFileSource'];
  const rootSelection =
    surface.rootSelection === undefined ? undefined : workspaceRootSelectionSchema.safeParse(surface.rootSelection);
  if (rootSelection && (!rootSelection.success || (type !== 'file' && type !== 'code'))) return null;
  if (surface.artifactFileSource !== undefined) {
    const parsed = artifactFileEntranceSchema.safeParse(surface.artifactFileSource);
    if (!parsed.success || (type !== 'file' && type !== 'code')) return null;
    artifactFileSource = parsed.data;
  }
  if (surface.messagePublicationSource !== undefined) {
    const source = messageMediaPublicationSourceSchema.safeParse(surface.messagePublicationSource);
    if (!source.success) return null;
    messagePublicationSource = source.data;
  }
  let filesReveal: WorkspaceSurfaceDescriptor['filesReveal'];
  if (surface.filesReveal !== undefined) {
    const candidate = asRecord(surface.filesReveal);
    if (
      !candidate ||
      !isNonEmptyString(candidate.path) ||
      candidate.path.length > 4096 ||
      !Number.isSafeInteger(candidate.request) ||
      Number(candidate.request) <= 0 ||
      type !== 'workspace'
    )
      return null;
    filesReveal = { path: candidate.path, request: Number(candidate.request) };
  }
  let filesRepoRoot: string | undefined;
  if (surface.filesRepoRoot !== undefined) {
    if (!isNonEmptyString(surface.filesRepoRoot) || surface.filesRepoRoot.length > 4096 || type !== 'workspace')
      return null;
    filesRepoRoot = surface.filesRepoRoot;
  }
  if (!legacySchema && (capabilities.sidecar !== true || capabilities.pin !== true)) return null;
  if (capabilities.mainAreaAttention !== undefined && capabilities.mainAreaAttention !== true) return null;
  const parsed: WorkspaceSurfaceDescriptor = {
    id: surface.id,
    type,
    renderer,
    title: surface.title,
    context: surface.context,
    objectRef: { kind: objectKind, id: objectRef.id },
    ownerStateRef: { owner: ownerStateRef.owner, key: ownerStateRef.key },
    ...(resultTargetRef === undefined ? {} : { resultTargetRef }),
    ...(navigationOrigin === undefined ? {} : { navigationOrigin }),
    ...(messagePublicationSource ? { messagePublicationSource } : {}),
    ...(artifactFileSource ? { artifactFileSource } : {}),
    ...(rootSelection?.success ? { rootSelection: rootSelection.data } : {}),
    ...(artifactListView ? { artifactListView } : {}),
    ...(filesReveal ? { filesReveal } : {}),
    ...(filesRepoRoot ? { filesRepoRoot } : {}),
    ...(returnTargetRef === undefined ? {} : { returnTargetRef }),
    capabilities: {
      split: true,
      sidecar: legacySchema ? true : capabilities.sidecar === true,
      pin: legacySchema ? true : capabilities.pin === true,
      ...(capabilities.mainAreaAttention === true ? { mainAreaAttention: true as const } : {}),
      closePolicy: 'detach-host',
      restorePolicy: 'descriptor',
    },
  };
  if (
    navigationOrigin &&
    type !== 'file' &&
    type !== 'code' &&
    !(ownerStateRef.owner === 'f232-thread-artifacts' && navigationOrigin.kind === 'artifact-list') &&
    resolveFilesTarget(parsed) === null &&
    resolveArtifactReviewTarget(parsed) === null &&
    resolvePublicationTarget(parsed) === null &&
    resolveMessagePublicationSource(parsed) === null &&
    resolveEvolutionMediaTarget(parsed) === null
  )
    return null;
  if ((filesReveal || filesRepoRoot) && resolveFilesTarget(parsed) === null) return null;
  if (ownerStateRef.owner === 'f138-publication' && resolvePublicationTarget(parsed) === null) return null;
  if (
    messagePublicationSource &&
    resolvePublicationTarget(parsed) === null &&
    resolveArtifactReviewTarget(parsed) === null
  )
    return null;
  if (ownerStateRef.owner === 'f138-message-source' && resolveMessagePublicationSource(parsed) === null) return null;
  if (ownerStateRef.owner === 'f311-media' && resolveEvolutionMediaTarget(parsed) === null) return null;
  if (
    returnTargetRef &&
    type !== 'artifact' &&
    type !== 'file' &&
    type !== 'code' &&
    resolveArtifactReviewTarget(parsed) === null
  )
    return null;
  return parsed;
}

function objectIdentity(surface: WorkspaceSurfaceDescriptor): string {
  return `${surface.objectRef.kind}:${surface.objectRef.id}`;
}

function parseSurfaceList(
  value: unknown,
  legacySchema: boolean,
  options: RestoreWorkbenchOptions,
): WorkspaceSurfaceDescriptor[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const objects = new Set<string>();
  const parsed: WorkspaceSurfaceDescriptor[] = [];
  for (const candidate of value) {
    const surface = parseSurface(candidate, legacySchema);
    if (surface === null || options.isOwnerRefAvailable?.(surface) === false) continue;
    const objectKey = objectIdentity(surface);
    if (ids.has(surface.id) || objects.has(objectKey)) continue;
    ids.add(surface.id);
    objects.add(objectKey);
    parsed.push(surface);
  }
  return parsed;
}

function warning(id: string, message: string): WorkbenchLayoutState['activity'][number] {
  return { id, kind: 'restore-warning', message };
}

function failedRestore(id = 'restore-warning:root'): WorkbenchLayoutState {
  return {
    ...createInitialWorkbenchState(),
    activity: [warning(id, '工作台布局无法识别，已恢复为安全空态。')],
  };
}

function restoreActiveSurface(
  raw: Record<string, unknown>,
  surfaces: WorkspaceSurfaceDescriptor[],
): { activeSurfaceId: string | null; requestedActive: string | null } {
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const requestedActive = isNonEmptyString(raw.activeSurfaceId) ? raw.activeSurfaceId : null;
  return {
    requestedActive,
    activeSurfaceId:
      requestedActive !== null && surfaceIds.has(requestedActive) ? requestedActive : (surfaces[0]?.id ?? null),
  };
}

function restoreSplit(raw: Record<string, unknown>, surfaceIds: Set<string>): WorkbenchLayoutState['split'] {
  const rawSplit = asRecord(raw.split);
  const primary = isNonEmptyString(rawSplit?.primarySurfaceId) ? rawSplit.primarySurfaceId : null;
  const secondary = isNonEmptyString(rawSplit?.secondarySurfaceId) ? rawSplit.secondarySurfaceId : null;
  if (
    primary === null ||
    secondary === null ||
    primary === secondary ||
    !surfaceIds.has(primary) ||
    !surfaceIds.has(secondary)
  ) {
    return null;
  }
  return { primarySurfaceId: primary, secondarySurfaceId: secondary };
}

function restoreSidecar(
  raw: Record<string, unknown>,
  legacySchema: boolean,
  surfaces: WorkspaceSurfaceDescriptor[],
  options: RestoreWorkbenchOptions,
): WorkspaceSurfaceDescriptor | null {
  if (legacySchema) return null;
  const sidecar = parseSurface(raw.sidecar, false);
  if (sidecar === null || options.isOwnerRefAvailable?.(sidecar) === false) return null;
  const duplicatesOpenSurface = surfaces.some(
    (surface) => surface.id === sidecar.id || objectIdentity(surface) === objectIdentity(sidecar),
  );
  return duplicatesOpenSurface ? null : sidecar;
}

function restorePinnedSurfaceIds(
  raw: Record<string, unknown>,
  legacySchema: boolean,
  surfaceIds: Set<string>,
): string[] {
  if (legacySchema || !Array.isArray(raw.pinnedSurfaceIds)) return [];
  return [...new Set(raw.pinnedSurfaceIds.filter((id): id is string => isNonEmptyString(id) && surfaceIds.has(id)))];
}

interface RestoreDamageInput {
  raw: Record<string, unknown>;
  legacySchema: boolean;
  rawSurfaceCount: number;
  surfaces: WorkspaceSurfaceDescriptor[];
  requestedActive: string | null;
  activeSurfaceId: string | null;
  split: WorkbenchLayoutState['split'];
  sidecar: WorkspaceSurfaceDescriptor | null;
  pinnedSurfaceIds: string[];
}

function hasRestoreDamage(input: RestoreDamageInput): boolean {
  const rawPinnedCount = Array.isArray(input.raw.pinnedSurfaceIds) ? input.raw.pinnedSurfaceIds.length : 0;
  return (
    input.legacySchema ||
    input.rawSurfaceCount !== input.surfaces.length ||
    (input.requestedActive !== null && input.requestedActive !== input.activeSurfaceId) ||
    (asRecord(input.raw.split) !== null && input.split === null) ||
    (!input.legacySchema && input.raw.sidecar !== null && input.sidecar === null) ||
    rawPinnedCount !== input.pinnedSurfaceIds.length
  );
}

export function restoreWorkbenchState(value: unknown, options: RestoreWorkbenchOptions = {}): WorkbenchLayoutState {
  const raw = asRecord(value);
  const legacySchema = raw?.schemaVersion === 1;
  if (raw === null || (!legacySchema && raw.schemaVersion !== 2) || raw.layoutOwner !== 'f307') {
    return failedRestore();
  }

  const rawSurfaceCount = Array.isArray(raw.surfaces) ? raw.surfaces.length : 0;
  const surfaces = parseSurfaceList(raw.surfaces, legacySchema, options);
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const { activeSurfaceId, requestedActive } = restoreActiveSurface(raw, surfaces);
  const split = restoreSplit(raw, surfaceIds);
  const sidecar = restoreSidecar(raw, legacySchema, surfaces, options);
  const recentlyClosed = parseSurfaceList(raw.recentlyClosed, legacySchema, options).filter(
    (surface) =>
      !surfaceIds.has(surface.id) && (sidecar === null || objectIdentity(surface) !== objectIdentity(sidecar)),
  );
  const pinnedSurfaceIds = restorePinnedSurfaceIds(raw, legacySchema, surfaceIds);
  const hadRestoreDamage = hasRestoreDamage({
    raw,
    legacySchema,
    rawSurfaceCount,
    surfaces,
    requestedActive,
    activeSurfaceId,
    split,
    sidecar,
    pinnedSurfaceIds,
  });

  return {
    schemaVersion: 2,
    layoutOwner: 'f307',
    surfaces,
    pinnedSurfaceIds,
    activeSurfaceId,
    split,
    sidecar,
    recentlyClosed,
    activity: hadRestoreDamage
      ? [warning('restore-warning:filtered', '部分布局引用已失效，已跳过并保留其余工作。')]
      : [],
  };
}
