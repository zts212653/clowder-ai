import type { ActiveExecutionProjection, GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { decodeTeamWorkspaceSubject, encodeTeamWorkspaceSubject } from '@/components/routing-context/team-navigation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import type { TrajectoryTarget } from '@/components/workspace/trajectory/trajectory-navigation';
import type { WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { WORKSPACE_MODE_META, type WorkspaceMode } from '@/lib/workspace-modes';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';

export const REAL_SURFACE_OWNERS = {
  agentRun: 'f299-invocation-trajectory',
  approval: 'f246-approval-navigation',
  artifact: 'f232-thread-artifacts',
  browser: 'f120-browser-preview',
  changes: 'f063-workspace-diff',
  evolutionProgram: 'f311-capability-evolution-control',
  file: 'f063-workspace-file',
  files: 'f063-workspace-tree',
  needsMe: 'f310-needs-me-navigation',
  productSchedule: 'f310-product-schedule-navigation',
  terminal: 'f089-terminal-session',
  team: 'f293-routing-context',
  workspace: 'f284-workspace-launcher',
} as const;

const LEGACY_OWNER_IDS = new Set(['f284-preview-registry', 'f284-thread-workspace']);
const REAL_OWNER_IDS = new Set<string>(Object.values(REAL_SURFACE_OWNERS));

export const SURFACE_CAPABILITIES: WorkspaceSurfaceDescriptor['capabilities'] = {
  split: true,
  sidecar: true,
  pin: true,
  closePolicy: 'detach-host',
  restorePolicy: 'descriptor',
};

function encodedId(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

function displayFileName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function isCodePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|css|scss|sass|less|json|ya?ml|toml|sql|sh|bash|zsh|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|vue|svelte)$/i.test(
    path,
  );
}

export function isRealSurfaceOwnerAvailable(surface: WorkspaceSurfaceDescriptor): boolean {
  return REAL_OWNER_IDS.has(surface.ownerStateRef.owner) || LEGACY_OWNER_IDS.has(surface.ownerStateRef.owner);
}

export function normalizeFileScrollToLine(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function createFileSurface(input: {
  worktreeId: string;
  path: string;
  scrollToLine?: number | null;
}): WorkspaceSurfaceDescriptor {
  const code = isCodePath(input.path);
  const scrollToLine = normalizeFileScrollToLine(input.scrollToLine);
  const targetKey = scrollToLine
    ? encodedId([input.worktreeId, input.path, scrollToLine])
    : `${input.worktreeId}:${input.path}`;
  return {
    id: `file-owner:${input.worktreeId}`,
    type: code ? 'code' : 'file',
    renderer: code ? 'code-editor' : 'file-preview',
    title: displayFileName(input.path),
    context: `${input.worktreeId} · ${input.path}`,
    objectRef: { kind: 'file', id: input.worktreeId },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.file, key: input.worktreeId },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.file, key: targetKey },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function createBrowserSurface(input: {
  ownerKey: string;
  port?: number;
  path?: string;
}): WorkspaceSurfaceDescriptor {
  const path = input.path ?? '/';
  const port = input.port ?? 0;
  return {
    id: `browser-owner:${input.ownerKey}`,
    type: 'browser',
    renderer: 'browser-preview',
    title: port > 0 ? `localhost:${port}` : '页面预览',
    context: port > 0 ? `${path} · managed preview` : 'managed preview',
    objectRef: { kind: 'preview-session', id: input.ownerKey },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.browser, key: input.ownerKey },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.browser, key: `${port}:${path}` },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function createTerminalSurface(input: { worktreeId: string }): WorkspaceSurfaceDescriptor {
  return {
    id: `terminal-owner:${input.worktreeId}`,
    type: 'terminal',
    renderer: 'terminal-session',
    title: '终端',
    context: input.worktreeId,
    objectRef: { kind: 'terminal-session', id: input.worktreeId },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.terminal, key: input.worktreeId },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.terminal, key: input.worktreeId },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function createEvolutionProgramSurface(programId: string): WorkspaceSurfaceDescriptor {
  return {
    id: `evolution-program:${programId}`,
    type: 'evolution-program',
    renderer: 'evolution-program',
    title: 'Evolution Program',
    context: 'Capability Evolution · canonical lifecycle',
    objectRef: { kind: 'evolution-program', id: programId },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.evolutionProgram, key: programId },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.evolutionProgram, key: programId },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function resolveEvolutionProgramId(surface: WorkspaceSurfaceDescriptor): string | null {
  if (
    surface.type !== 'evolution-program' ||
    surface.renderer !== 'evolution-program' ||
    surface.objectRef.kind !== 'evolution-program' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.evolutionProgram ||
    surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.evolutionProgram ||
    surface.objectRef.id !== surface.ownerStateRef.key ||
    surface.objectRef.id !== surface.resultTargetRef.key ||
    !/^evolution-program:[0-9a-f]{32}$/.test(surface.objectRef.id)
  ) {
    return null;
  }
  return surface.objectRef.id;
}

export function artifactObjectId(artifact: ThreadArtifactDTO): string {
  return encodedId([
    artifact.type,
    artifact.ref ?? null,
    artifact.url ?? null,
    artifact.sourceMessageId,
    artifact.createdAt,
    artifact.name,
  ]);
}

export function createArtifactSurface(input: {
  threadId: string;
  artifact: ThreadArtifactDTO | GlobalArtifactDTO;
}): WorkspaceSurfaceDescriptor {
  const ownerThreadId = 'threadId' in input.artifact ? input.artifact.threadId : input.threadId;
  const review = input.artifact.type === 'pr';
  const objectId = artifactObjectId(input.artifact);
  const resultTargetRef = input.artifact.sourceMessageId
    ? { owner: 'thread-message', key: `${ownerThreadId}:${input.artifact.sourceMessageId}` }
    : input.artifact.ref
      ? { owner: review ? 'review-ref' : 'artifact-ref', key: input.artifact.ref }
      : { owner: REAL_SURFACE_OWNERS.artifact, key: `${ownerThreadId}:${objectId}` };
  return {
    id: `${review ? 'review' : 'artifact'}:${ownerThreadId}:${objectId}`,
    type: review ? 'review' : 'artifact',
    renderer: review ? 'review-summary' : 'artifact-view',
    title: input.artifact.name,
    context: review ? (input.artifact.ref ?? 'PR Review') : `Thread 产物 · ${input.artifact.type}`,
    objectRef: { kind: review ? 'review' : 'artifact', id: objectId },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.artifact, key: ownerThreadId },
    resultTargetRef,
    capabilities: SURFACE_CAPABILITIES,
  };
}

type AgentRunAdapterInput =
  | {
      execution: Pick<ActiveExecutionProjection, 'catId' | 'executionId' | 'threadId' | 'threadTitle'>;
      sourceMessageId?: string;
    }
  | {
      invocationId: string;
      threadId: string;
      title?: string;
      catId?: string;
      sourceMessageId?: string;
    };

export function createAgentRunSurface(input: AgentRunAdapterInput): WorkspaceSurfaceDescriptor {
  const invocationId = 'execution' in input ? input.execution.executionId : input.invocationId;
  const threadId = 'execution' in input ? input.execution.threadId : input.threadId;
  const title =
    'execution' in input
      ? (input.execution.threadTitle ?? `${input.execution.catId} Agent Run`)
      : (input.title ?? `${input.catId ?? 'Agent'} Run`);
  const sourceMessageId = input.sourceMessageId;
  return {
    id: `agent-run:${invocationId}`,
    type: 'agent-run',
    renderer: 'agent-run',
    title,
    context: `Invocation · ${invocationId}`,
    objectRef: { kind: 'agent-run', id: invocationId },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.agentRun, key: `${threadId}:${invocationId}` },
    resultTargetRef: sourceMessageId
      ? { owner: 'thread-message', key: `${threadId}:${sourceMessageId}` }
      : { owner: REAL_SURFACE_OWNERS.agentRun, key: `${threadId}:${invocationId}` },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function createWorkspaceDestinationSurface(
  destination: WorkspaceLauncherDestination,
  threadId?: string,
  worktreeId?: string | null,
): WorkspaceSurfaceDescriptor | null {
  if (destination.kind === 'action' || destination.kind === 'workspace') return null;
  if (destination.kind === 'mode' && destination.id === 'team') {
    return createTeamWorkspaceSurface({ threadId });
  }
  const destinationRef = `${destination.kind}:${destination.id}`;
  if (destinationRef === 'surface:files') {
    return worktreeId ? createFilesSurface(worktreeId) : null;
  }
  if (destinationRef === 'surface:changes') {
    if (!worktreeId) return null;
    return {
      id: `workspace:${destinationRef}:${worktreeId}`,
      type: 'workspace',
      renderer: 'workspace-destination',
      title: destination.label,
      context: `${worktreeId} · ${destination.description}`,
      objectRef: { kind: 'workspace-destination', id: destinationRef },
      ownerStateRef: { owner: REAL_SURFACE_OWNERS.changes, key: worktreeId },
      resultTargetRef: {
        owner: REAL_SURFACE_OWNERS.changes,
        key: threadId ? encodedId([worktreeId, threadId]) : worktreeId,
      },
      capabilities: SURFACE_CAPABILITIES,
    };
  }
  return {
    id: `workspace:${destinationRef}`,
    type: 'workspace',
    renderer: 'workspace-destination',
    title: destination.label,
    context: destination.description,
    objectRef: { kind: 'workspace-destination', id: destinationRef },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.workspace, key: destinationRef },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.workspace, key: `${threadId ?? 'global'}:${destinationRef}` },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function createFilesSurface(worktreeId: string): WorkspaceSurfaceDescriptor {
  return {
    id: `workspace:surface:files:${worktreeId}`,
    type: 'workspace',
    renderer: 'workspace-destination',
    title: '文件与代码',
    context: `${worktreeId} · 浏览与打开工作区文件`,
    objectRef: { kind: 'workspace-destination', id: 'surface:files' },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.files, key: worktreeId },
    resultTargetRef: { owner: REAL_SURFACE_OWNERS.files, key: worktreeId },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function createWorkspaceModeSurface(
  mode: Exclude<WorkspaceMode, 'dev' | 'team'>,
  threadId?: string,
): WorkspaceSurfaceDescriptor {
  const meta = WORKSPACE_MODE_META[mode];
  const surface = createWorkspaceDestinationSurface(
    {
      kind: 'mode',
      id: mode,
      label: meta.label,
      description: meta.description,
      searchTerms: meta.searchTerms,
    },
    threadId,
  );
  if (!surface) throw new Error(`Workspace mode ${mode} must resolve to an owner surface`);
  return surface;
}

export function createTeamWorkspaceSurface(input: {
  threadId?: string;
  subject?: TeamWorkspaceSubject | null;
}): WorkspaceSurfaceDescriptor {
  const ownerKey = input.threadId ?? 'global';
  return {
    id: `workspace:mode:team:${ownerKey}`,
    type: 'workspace',
    renderer: 'workspace-destination',
    title: '猫猫团队',
    context: input.subject ? `${input.subject.type} · ${input.subject.id}` : '成员能力、当前路由状态与协作偏好',
    objectRef: { kind: 'workspace-destination', id: 'mode:team' },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.team, key: ownerKey },
    resultTargetRef: {
      owner: REAL_SURFACE_OWNERS.team,
      key: input.subject ? encodeTeamWorkspaceSubject(input.subject) : 'list',
    },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function resolveTeamWorkspaceTarget(
  surface: WorkspaceSurfaceDescriptor,
): { threadId: string | null; subject: TeamWorkspaceSubject | null } | null {
  if (
    surface.id !== `workspace:mode:team:${surface.ownerStateRef.key}` ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.objectRef.id !== 'mode:team' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.team ||
    surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.team ||
    surface.ownerStateRef.key.length === 0
  ) {
    return null;
  }
  const subject =
    surface.resultTargetRef.key === 'list' ? null : decodeTeamWorkspaceSubject(surface.resultTargetRef.key);
  if (surface.resultTargetRef.key !== 'list' && !subject) return null;
  return { threadId: surface.ownerStateRef.key === 'global' ? null : surface.ownerStateRef.key, subject };
}

export function createNeedsMeReturnSurface(
  surface: WorkspaceSurfaceDescriptor,
  itemRef: string,
): WorkspaceSurfaceDescriptor | null {
  const target = resolveWorkspaceDestinationTarget(surface);
  if (!target || target.destinationRef !== 'mode:needs-me' || itemRef.trim().length === 0) return null;
  return {
    ...surface,
    resultTargetRef: {
      owner: REAL_SURFACE_OWNERS.needsMe,
      key: encodedId([target.threadId ?? 'global', itemRef]),
    },
  };
}

export function createApprovalActionSurface(
  sourceSurface: WorkspaceSurfaceDescriptor,
  proposalId: string,
): WorkspaceSurfaceDescriptor | null {
  const sourceTarget = resolveWorkspaceDestinationTarget(sourceSurface);
  if (!sourceTarget || proposalId.trim().length === 0) return null;
  return {
    id: 'workspace:mode:approval',
    type: 'workspace',
    renderer: 'workspace-destination',
    title: '审批',
    context: '等待你判断或授权的事项',
    objectRef: { kind: 'workspace-destination', id: 'mode:approval' },
    ownerStateRef: { owner: REAL_SURFACE_OWNERS.workspace, key: 'mode:approval' },
    resultTargetRef: {
      owner: REAL_SURFACE_OWNERS.approval,
      key: encodedId([sourceTarget.threadId ?? 'global', proposalId]),
    },
    capabilities: SURFACE_CAPABILITIES,
  };
}

export function resolveApprovalActionTarget(
  surface: WorkspaceSurfaceDescriptor,
): { threadId: string | null; proposalId: string | null } | null {
  if (
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.objectRef.id !== 'mode:approval' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.workspace ||
    surface.ownerStateRef.key !== 'mode:approval'
  ) {
    return null;
  }
  if (surface.resultTargetRef?.owner === REAL_SURFACE_OWNERS.workspace) {
    const target = splitOwnerKey(surface.resultTargetRef.key);
    if (!target || target[1] !== 'mode:approval') return null;
    return { threadId: target[0] === 'global' ? null : target[0], proposalId: null };
  }
  if (surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.approval) return null;
  const target = decodeStringPair(surface.resultTargetRef.key);
  if (!target) return null;
  return { threadId: target[0] === 'global' ? null : target[0], proposalId: target[1] };
}

export function createProductScheduleReturnSurface(
  surface: WorkspaceSurfaceDescriptor,
  itemRef: string,
): WorkspaceSurfaceDescriptor | null {
  return createEntrustedWorkReturnSurface(
    surface,
    itemRef,
    'mode:product-schedule',
    REAL_SURFACE_OWNERS.productSchedule,
  );
}

function createEntrustedWorkReturnSurface(
  surface: WorkspaceSurfaceDescriptor,
  itemRef: string,
  destinationRef: 'mode:needs-me' | 'mode:product-schedule',
  owner: string,
): WorkspaceSurfaceDescriptor | null {
  const target = resolveWorkspaceDestinationTarget(surface);
  if (!target || target.destinationRef !== destinationRef || itemRef.trim().length === 0) return null;
  return {
    ...surface,
    resultTargetRef: {
      owner,
      key: encodedId([target.threadId ?? 'global', itemRef]),
    },
  };
}

export function resolveNeedsMeReturnTarget(
  surface: WorkspaceSurfaceDescriptor,
): { threadId: string | null; itemRef: string | null } | null {
  if (
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.objectRef.id !== 'mode:needs-me' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.workspace ||
    surface.ownerStateRef.key !== 'mode:needs-me'
  ) {
    return null;
  }
  if (surface.resultTargetRef?.owner === REAL_SURFACE_OWNERS.workspace) {
    const target = splitOwnerKey(surface.resultTargetRef.key);
    if (!target || target[1] !== 'mode:needs-me') return null;
    return { threadId: target[0] === 'global' ? null : target[0], itemRef: null };
  }
  if (surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.needsMe) return null;
  const decoded = decodeStringPair(surface.resultTargetRef.key);
  if (!decoded) return null;
  return { threadId: decoded[0] === 'global' ? null : decoded[0], itemRef: decoded[1] };
}

export function resolveProductScheduleReturnTarget(
  surface: WorkspaceSurfaceDescriptor,
): { threadId: string | null; itemRef: string | null } | null {
  return resolveEntrustedWorkReturnTarget(surface, 'mode:product-schedule', REAL_SURFACE_OWNERS.productSchedule);
}

function resolveEntrustedWorkReturnTarget(
  surface: WorkspaceSurfaceDescriptor,
  destinationRef: 'mode:needs-me' | 'mode:product-schedule',
  navigationOwner: string,
): { threadId: string | null; itemRef: string | null } | null {
  if (
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.objectRef.id !== destinationRef ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.workspace ||
    surface.ownerStateRef.key !== destinationRef
  ) {
    return null;
  }
  if (surface.resultTargetRef?.owner === REAL_SURFACE_OWNERS.workspace) {
    const target = splitOwnerKey(surface.resultTargetRef.key);
    if (!target || target[1] !== destinationRef) return null;
    return { threadId: target[0] === 'global' ? null : target[0], itemRef: null };
  }
  if (surface.resultTargetRef?.owner !== navigationOwner) return null;
  const decoded = decodeStringPair(surface.resultTargetRef.key);
  if (!decoded) return null;
  return { threadId: decoded[0] === 'global' ? null : decoded[0], itemRef: decoded[1] };
}

export function resolveFilesTarget(surface: WorkspaceSurfaceDescriptor): { worktreeId: string } | null {
  if (
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.objectRef.id !== 'surface:files' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.files ||
    surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.files ||
    surface.ownerStateRef.key.length === 0 ||
    surface.ownerStateRef.key !== surface.resultTargetRef.key ||
    surface.id !== `workspace:surface:files:${surface.ownerStateRef.key}`
  ) {
    return null;
  }
  return { worktreeId: surface.ownerStateRef.key };
}

export function resolveChangesTarget(
  surface: WorkspaceSurfaceDescriptor,
): { worktreeId: string; threadId: string | null } | null {
  if (
    surface.renderer !== 'workspace-destination' ||
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.objectRef.id !== 'surface:changes' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.changes ||
    surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.changes ||
    surface.ownerStateRef.key.length === 0 ||
    surface.id !== `workspace:surface:changes:${surface.ownerStateRef.key}`
  ) {
    return null;
  }
  if (surface.resultTargetRef.key === surface.ownerStateRef.key) {
    return { worktreeId: surface.ownerStateRef.key, threadId: null };
  }
  const target = decodeChangesTarget(surface.resultTargetRef.key);
  if (!target || target[0] !== surface.ownerStateRef.key) return null;
  return { worktreeId: target[0], threadId: target[1] };
}

function decodeChangesTarget(key: string): [string, string] | null {
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(key));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      decoded[0].length === 0 ||
      typeof decoded[1] !== 'string' ||
      decoded[1].length === 0
    ) {
      return null;
    }
    return [decoded[0], decoded[1]];
  } catch {
    return null;
  }
}

export function resolveWorkspaceDestinationTarget(
  surface: WorkspaceSurfaceDescriptor,
): { destinationRef: string; threadId: string | null } | null {
  if (
    surface.objectRef.kind !== 'workspace-destination' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.workspace ||
    surface.ownerStateRef.key !== surface.objectRef.id
  ) {
    return null;
  }
  const approvalTarget = resolveApprovalActionTarget(surface);
  if (approvalTarget) return { destinationRef: 'mode:approval', threadId: approvalTarget.threadId };
  if (surface.objectRef.id === 'mode:needs-me' || surface.objectRef.id === 'mode:product-schedule') {
    const returnTarget =
      surface.objectRef.id === 'mode:needs-me'
        ? resolveNeedsMeReturnTarget(surface)
        : resolveProductScheduleReturnTarget(surface);
    return returnTarget ? { destinationRef: surface.objectRef.id, threadId: returnTarget.threadId } : null;
  }
  if (surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.workspace) return null;
  const target = splitOwnerKey(surface.resultTargetRef.key);
  if (!target || target[1] !== surface.objectRef.id) return null;
  return { destinationRef: target[1], threadId: target[0] === 'global' ? null : target[0] };
}

function decodeStringPair(key: string): [string, string] | null {
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(key));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      decoded[0].length === 0 ||
      typeof decoded[1] !== 'string' ||
      decoded[1].length === 0
    ) {
      return null;
    }
    return [decoded[0], decoded[1]];
  } catch {
    return null;
  }
}

export function resolveTerminalWorktreeId(surface: WorkspaceSurfaceDescriptor): string | null {
  return surface.ownerStateRef.owner === REAL_SURFACE_OWNERS.terminal ? surface.ownerStateRef.key : null;
}

export function resolveArtifactTarget(
  surface: WorkspaceSurfaceDescriptor,
): { threadId: string; artifactId: string } | null {
  if (surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.artifact) return null;
  return { threadId: surface.ownerStateRef.key, artifactId: surface.objectRef.id };
}

function splitOwnerKey(key: string): [string, string] | null {
  const separator = key.indexOf(':');
  return separator > 0 && separator < key.length - 1 ? [key.slice(0, separator), key.slice(separator + 1)] : null;
}

function decodeFileTarget(key: string): { worktreeId: string; path: string; scrollToLine: number | null } | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(key));
    if (Array.isArray(parsed)) {
      const candidate = parsed as unknown[];
      if (
        candidate.length === 3 &&
        typeof candidate[0] === 'string' &&
        candidate[0].length > 0 &&
        typeof candidate[1] === 'string' &&
        candidate[1].length > 0 &&
        typeof candidate[2] === 'number' &&
        Number.isSafeInteger(candidate[2]) &&
        candidate[2] > 0
      ) {
        return { worktreeId: candidate[0], path: candidate[1], scrollToLine: candidate[2] };
      }
    }
  } catch {
    // Legacy descriptors use the unencoded worktree:path target below.
  }

  const legacyTarget = splitOwnerKey(key);
  return legacyTarget ? { worktreeId: legacyTarget[0], path: legacyTarget[1], scrollToLine: null } : null;
}

export function resolveFileTarget(
  surface: WorkspaceSurfaceDescriptor,
): { worktreeId: string; path: string; scrollToLine: number | null } | null {
  if (
    surface.objectRef.kind !== 'file' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.file ||
    surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.file
  ) {
    return null;
  }
  const target = decodeFileTarget(surface.resultTargetRef.key);
  if (!target || target.worktreeId !== surface.ownerStateRef.key || surface.objectRef.id !== target.worktreeId) {
    return null;
  }
  return target;
}

export function resolveBrowserTarget(
  surface: WorkspaceSurfaceDescriptor,
): { ownerKey: string; port: number; path: string } | null {
  if (
    surface.objectRef.kind !== 'preview-session' ||
    surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.browser ||
    surface.resultTargetRef?.owner !== REAL_SURFACE_OWNERS.browser ||
    surface.objectRef.id !== surface.ownerStateRef.key
  ) {
    return null;
  }
  const target = splitOwnerKey(surface.resultTargetRef.key);
  if (!target || !/^\d+$/.test(target[0])) return null;
  const port = Number(target[0]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !target[1].startsWith('/')) return null;
  return { ownerKey: surface.ownerStateRef.key, port, path: target[1] };
}

export function resolveAgentRunTarget(surface: WorkspaceSurfaceDescriptor): TrajectoryTarget | null {
  if (surface.ownerStateRef.owner !== REAL_SURFACE_OWNERS.agentRun) return null;
  const ownerKey = splitOwnerKey(surface.ownerStateRef.key);
  if (!ownerKey) return null;
  const [threadId, invocationId] = ownerKey;
  if (surface.resultTargetRef?.owner !== 'thread-message') return { threadId, invocationId };
  const resultKey = splitOwnerKey(surface.resultTargetRef.key);
  if (!resultKey || resultKey[0] !== threadId) return { threadId, invocationId };
  return {
    threadId,
    invocationId,
    originRef: {
      kind: 'message',
      threadId,
      messageId: resultKey[1],
      viewportOffsetPx: 0,
    },
  };
}
