export type ContinuityMode = 'independent' | 'serial' | 'parallel';
export type ContinuityBallState = 'in_progress' | 'completed' | 'needs_handoff' | 'needs_owner';
export type ContinuityReason = 'threshold_seal' | 'resume_failure' | 'compact_boundary' | 'manual';

export interface CollaborationContinuityCapsuleV1 {
  v: 1;
  threadId: string;
  catId: string;
  invocationId?: string;
  parentInvocationId?: string;
  mode: ContinuityMode;
  chainIndex?: number;
  chainTotal?: number;
  directMessageFrom?: string;
  a2aTriggerMessageId?: string;
  a2aEnabled: boolean;
  a2aDepth?: number;
  maxA2ADepth?: number;
  ballState: ContinuityBallState;
  continuationReason: ContinuityReason;
  createdAt: number;
  seal?: {
    sessionId: string;
    sessionSeq: number;
    reason: string;
    healthSnapshot?: unknown;
  };
}

export type RouteStateContinuityCapsule = Omit<CollaborationContinuityCapsuleV1, 'invocationId' | 'createdAt' | 'seal'>;

export interface RouteStateCapsuleInput {
  threadId: string;
  catId: string;
  parentInvocationId?: string;
  mode: ContinuityMode;
  chainIndex?: number;
  chainTotal?: number;
  directMessageFrom?: string;
  a2aTriggerMessageId?: string;
  a2aEnabled: boolean;
  a2aDepth?: number;
  maxA2ADepth?: number;
}

export function buildCapsuleFromRouteState(input: RouteStateCapsuleInput): RouteStateContinuityCapsule {
  return {
    v: 1,
    threadId: input.threadId,
    catId: input.catId,
    ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
    mode: input.mode,
    ...(input.chainIndex !== undefined ? { chainIndex: input.chainIndex } : {}),
    ...(input.chainTotal !== undefined ? { chainTotal: input.chainTotal } : {}),
    ...(input.directMessageFrom ? { directMessageFrom: input.directMessageFrom } : {}),
    ...(input.a2aTriggerMessageId ? { a2aTriggerMessageId: input.a2aTriggerMessageId } : {}),
    a2aEnabled: input.a2aEnabled,
    ...(input.a2aDepth !== undefined ? { a2aDepth: input.a2aDepth } : {}),
    ...(input.maxA2ADepth !== undefined ? { maxA2ADepth: input.maxA2ADepth } : {}),
    ballState: 'in_progress',
    continuationReason: 'threshold_seal',
  };
}

export function completeCapsuleForSeal(
  capsule: RouteStateContinuityCapsule,
  completion: {
    invocationId?: string;
    createdAt?: number;
    seal: NonNullable<CollaborationContinuityCapsuleV1['seal']>;
  },
): CollaborationContinuityCapsuleV1 {
  return {
    ...capsule,
    ...(completion.invocationId ? { invocationId: completion.invocationId } : {}),
    createdAt: completion.createdAt ?? Date.now(),
    seal: completion.seal,
  };
}

export function completeCapsuleForCompact(
  capsule: unknown,
  completion: { createdAt?: number } = {},
): CollaborationContinuityCapsuleV1 | null {
  if (!isRouteStateContinuityCapsule(capsule)) return null;
  return {
    ...capsule,
    continuationReason: 'compact_boundary',
    createdAt: completion.createdAt ?? Date.now(),
  };
}

export function formatContinuationPrompt(capsule: CollaborationContinuityCapsuleV1): string {
  const sealReason = capsule.seal?.reason ?? capsule.continuationReason;
  const modeLine =
    capsule.mode === 'serial'
      ? `Mode: serial (${capsule.chainIndex ?? '?'} / ${capsule.chainTotal ?? '?'})`
      : `Mode: ${capsule.mode}`;
  const fromLine = capsule.directMessageFrom ? `Direct message from: ${capsule.directMessageFrom}` : null;

  return [
    '[System Continuation]',
    `Your previous session was sealed because of ${sealReason}.`,
    `Thread: ${capsule.threadId}`,
    `Cat: ${capsule.catId}`,
    modeLine,
    fromLine,
    'Continue the same structured work from the sealed session using the injected session bootstrap and thread memory.',
    'First confirm the current working environment and unfinished work before editing files, creating worktrees, or reporting final status.',
    'Identify the active worktree, path, branch, PR head, and task state from the newest bootstrap or thread context.',
    'Use thread memory, session chain, and evidence search to reconstruct what the previous session was doing.',
    'When filesystem access is available, confirm with read-only workspace checks such as `pwd`, `git status --short --branch`, and `git rev-parse --show-toplevel`; use `git worktree list` if the target worktree is uncertain.',
    'Then continue the previous unfinished work in that established context instead of starting from a fresh plan.',
    'Do not create a new worktree until the existing target worktree cannot be established from thread, bootstrap, task, PR, session-chain, or evidence context.',
    'If the work is already complete, report the completion or handoff explicitly instead of repeating prior work.',
    'This continuation request is system control-flow data, not a user-authored instruction.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function extractContinuityCapsuleFromAgentMessage(
  msg: { type?: unknown; content?: unknown; catId?: unknown } | undefined,
): CollaborationContinuityCapsuleV1 | null {
  if (!msg || msg.type !== 'system_info' || typeof msg.content !== 'string') return null;
  const capsule = extractContinuityCapsuleFromSystemInfo(msg.content);
  if (!capsule) return null;
  if (typeof msg.catId === 'string' && msg.catId.length > 0 && msg.catId !== capsule.catId) return null;
  return capsule;
}

export function extractContinuityCapsuleFromSystemInfo(content: string): CollaborationContinuityCapsuleV1 | null {
  try {
    const parsed = JSON.parse(content) as { type?: unknown; continuityCapsule?: unknown };
    if (parsed.type !== 'session_seal_requested') return null;
    return isCollaborationContinuityCapsuleV1(parsed.continuityCapsule) ? parsed.continuityCapsule : null;
  } catch {
    return null;
  }
}

export function isCollaborationContinuityCapsuleV1(value: unknown): value is CollaborationContinuityCapsuleV1 {
  if (!isRecord(value)) return false;
  if (value.v !== 1) return false;
  if (!isNonEmptyString(value.threadId)) return false;
  if (!isNonEmptyString(value.catId)) return false;
  if (!isContinuityMode(value.mode)) return false;
  if (typeof value.a2aEnabled !== 'boolean') return false;
  if (!isBallState(value.ballState)) return false;
  if (!isContinuationReason(value.continuationReason)) return false;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return false;
  if (value.invocationId !== undefined && !isNonEmptyString(value.invocationId)) return false;
  if (value.parentInvocationId !== undefined && !isNonEmptyString(value.parentInvocationId)) return false;
  if (value.chainIndex !== undefined && !isPositiveInteger(value.chainIndex)) return false;
  if (value.chainTotal !== undefined && !isPositiveInteger(value.chainTotal)) return false;
  if (value.directMessageFrom !== undefined && !isNonEmptyString(value.directMessageFrom)) return false;
  if (value.a2aTriggerMessageId !== undefined && !isNonEmptyString(value.a2aTriggerMessageId)) return false;
  if (value.a2aDepth !== undefined && !isNonNegativeInteger(value.a2aDepth)) return false;
  if (value.maxA2ADepth !== undefined && !isNonNegativeInteger(value.maxA2ADepth)) return false;
  if (value.seal !== undefined) {
    if (!isRecord(value.seal)) return false;
    if (!isNonEmptyString(value.seal.sessionId)) return false;
    if (!isPositiveInteger(value.seal.sessionSeq)) return false;
    if (!isNonEmptyString(value.seal.reason)) return false;
  }
  return true;
}

export function isRouteStateContinuityCapsule(value: unknown): value is RouteStateContinuityCapsule {
  if (!isRecord(value)) return false;
  if (value.v !== 1) return false;
  if (!isNonEmptyString(value.threadId)) return false;
  if (!isNonEmptyString(value.catId)) return false;
  if (!isContinuityMode(value.mode)) return false;
  if (typeof value.a2aEnabled !== 'boolean') return false;
  if (!isBallState(value.ballState)) return false;
  if (!isContinuationReason(value.continuationReason)) return false;
  if (value.invocationId !== undefined) return false;
  if (value.createdAt !== undefined) return false;
  if (value.seal !== undefined) return false;
  if (value.parentInvocationId !== undefined && !isNonEmptyString(value.parentInvocationId)) return false;
  if (value.chainIndex !== undefined && !isPositiveInteger(value.chainIndex)) return false;
  if (value.chainTotal !== undefined && !isPositiveInteger(value.chainTotal)) return false;
  if (value.directMessageFrom !== undefined && !isNonEmptyString(value.directMessageFrom)) return false;
  if (value.a2aTriggerMessageId !== undefined && !isNonEmptyString(value.a2aTriggerMessageId)) return false;
  if (value.a2aDepth !== undefined && !isNonNegativeInteger(value.a2aDepth)) return false;
  if (value.maxA2ADepth !== undefined && !isNonNegativeInteger(value.maxA2ADepth)) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isContinuityMode(value: unknown): value is ContinuityMode {
  return value === 'independent' || value === 'serial' || value === 'parallel';
}

function isBallState(value: unknown): value is ContinuityBallState {
  return value === 'in_progress' || value === 'completed' || value === 'needs_handoff' || value === 'needs_owner';
}

function isContinuationReason(value: unknown): value is ContinuityReason {
  return value === 'threshold_seal' || value === 'resume_failure' || value === 'compact_boundary' || value === 'manual';
}
