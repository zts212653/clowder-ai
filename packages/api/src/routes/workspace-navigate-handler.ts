import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsoluteFilesystemPath } from '@cat-cafe/shared/utils';
import { AuditEventTypes, type EventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import {
  emitWorkspaceNavigate,
  type WorkspaceNavigationEmitter,
} from '../domains/workspace/workspace-navigation-delivery.js';
import { resolveWorkspaceAbsolutePath } from '../domains/workspace/workspace-path-resolution.js';
import {
  getWorktreeRoot,
  resolveWorkspaceFilesystemPath,
  resolveWorktreeIdByPath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';

export type ResolveWorktreeIdByPathForNavigate = (root: string) => Promise<string>;

export interface WorktreeCanonicalizationFallbackProbe {
  reason: 'resolve_failed';
  requestedWorktreeId: string;
  errorName: string;
  errorMessage: string;
  errorCode?: string;
}

export interface WorktreeCanonicalizationProbe {
  worktreeId: string;
  canonicalized: boolean;
  fallback?: WorktreeCanonicalizationFallbackProbe;
}

export interface WorkspaceNavigateBody {
  worktreeId?: string;
  path?: string;
  action?: 'reveal' | 'open' | 'knowledge-feed';
  line?: number;
  threadId?: string;
  catId?: string;
}

export type WorkspaceNavigateBodyParseResult = { ok: true; body: WorkspaceNavigateBody } | { ok: false; error: string };

const WORKSPACE_NAVIGATE_ACTIONS = new Set<NonNullable<WorkspaceNavigateBody['action']>>([
  'reveal',
  'open',
  'knowledge-feed',
]);

export function parseWorkspaceNavigateBody(value: unknown): WorkspaceNavigateBodyParseResult {
  if (value === undefined) return { ok: true, body: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Request body must be an object' };
  }
  const candidate = value as Record<string, unknown>;
  for (const field of ['worktreeId', 'path', 'threadId', 'catId'] as const) {
    const fieldValue = candidate[field];
    if (fieldValue !== undefined && (typeof fieldValue !== 'string' || fieldValue.length === 0)) {
      return { ok: false, error: `${field} must be a non-empty string` };
    }
  }
  if (
    candidate.action !== undefined &&
    (typeof candidate.action !== 'string' ||
      !WORKSPACE_NAVIGATE_ACTIONS.has(candidate.action as NonNullable<WorkspaceNavigateBody['action']>))
  ) {
    return { ok: false, error: 'action must be reveal, open, or knowledge-feed' };
  }
  if (
    candidate.line !== undefined &&
    (typeof candidate.line !== 'number' || !Number.isInteger(candidate.line) || candidate.line < 1)
  ) {
    return { ok: false, error: 'line must be a positive integer' };
  }
  return { ok: true, body: candidate as WorkspaceNavigateBody };
}

interface NavigateTargetResolution {
  path: string;
  worktreeId: string;
  canonicalization: WorktreeCanonicalizationProbe;
}

interface WorkspaceNavigateDeps extends WorkspaceNavigationEmitter {
  auditLog: EventAuditLog;
  resolveWorktreeIdByPathForNavigate?: ResolveWorktreeIdByPathForNavigate;
  warn: (data: unknown, message: string) => void;
}

export interface WorkspaceNavigateRouteResult {
  statusCode: number;
  body: unknown;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export async function canonicalizeNavigateWorktreeId(
  requestedWorktreeId: string,
  root: string,
  resolver: ResolveWorktreeIdByPathForNavigate = resolveWorktreeIdByPath,
): Promise<WorktreeCanonicalizationProbe> {
  try {
    const resolvedWorktreeId = await resolver(root);
    return {
      worktreeId: resolvedWorktreeId,
      canonicalized: resolvedWorktreeId !== requestedWorktreeId,
    };
  } catch (error) {
    const errorCode = getErrorCode(error);
    return {
      worktreeId: requestedWorktreeId,
      canonicalized: false,
      fallback: {
        reason: 'resolve_failed',
        requestedWorktreeId,
        errorName: error instanceof Error ? error.name : 'Error',
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(errorCode ? { errorCode } : {}),
      },
    };
  }
}

async function resolveNavigateTarget(input: {
  requestedPath: string;
  requestedWorktreeId?: string;
  worktreeIdResolver?: ResolveWorktreeIdByPathForNavigate;
}): Promise<NavigateTargetResolution> {
  if (isAbsoluteFilesystemPath(input.requestedPath)) {
    const target = await resolveWorkspaceAbsolutePath(input.requestedPath);
    return {
      path: target.path,
      worktreeId: target.worktreeId,
      canonicalization: {
        worktreeId: target.worktreeId,
        canonicalized: target.worktreeId !== input.requestedWorktreeId,
      },
    };
  }
  if (!input.requestedWorktreeId) {
    throw new WorkspaceSecurityError('worktreeId required for repo-relative paths', 'NOT_FOUND');
  }
  const root = await getWorktreeRoot(input.requestedWorktreeId);
  const canonicalization = await canonicalizeNavigateWorktreeId(
    input.requestedWorktreeId,
    root,
    input.worktreeIdResolver,
  );
  await stat(await resolveWorkspaceFilesystemPath(root, input.requestedPath));
  return {
    path: input.requestedPath,
    worktreeId: canonicalization.worktreeId,
    canonicalization,
  };
}

async function resolveNavigateTargetRouteResult(input: {
  requestedPath: string;
  requestedWorktreeId?: string;
  worktreeIdResolver?: ResolveWorktreeIdByPathForNavigate;
}): Promise<{ target: NavigateTargetResolution } | WorkspaceNavigateRouteResult> {
  try {
    return { target: await resolveNavigateTarget(input) };
  } catch (error) {
    if (error instanceof WorkspaceSecurityError) {
      return { statusCode: error.code === 'NOT_FOUND' ? 404 : 403, body: { error: error.message } };
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { statusCode: 404, body: { error: 'File not found' } };
    }
    return { statusCode: 500, body: { error: 'Internal error' } };
  }
}

async function handleKnowledgeFeed(
  body: WorkspaceNavigateBody,
  deps: WorkspaceNavigateDeps,
): Promise<WorkspaceNavigateRouteResult> {
  if (!body.threadId) {
    return { statusCode: 400, body: { error: 'threadId required for knowledge-feed action' } };
  }
  const eventData = {
    path: '',
    worktreeId: body.worktreeId ?? '',
    action: 'knowledge-feed' as const,
    threadId: body.threadId,
    eventId: randomUUID(),
  };
  const delivery = await emitWorkspaceNavigate(deps, eventData, ['workspace:global']);
  deps.auditLog
    .append({
      type: AuditEventTypes.WORKSPACE_NAVIGATE,
      threadId: body.threadId,
      data: {
        worktreeId: body.worktreeId,
        path: '',
        action: 'knowledge-feed',
        line: undefined,
        catId: body.catId,
      },
    })
    .catch(() => {});
  return { statusCode: 200, body: { ok: true, action: 'knowledge-feed', ...delivery } };
}

async function handleFileNavigation(
  body: WorkspaceNavigateBody,
  deps: WorkspaceNavigateDeps,
): Promise<WorkspaceNavigateRouteResult> {
  if (!body.path || (!body.worktreeId && !isAbsoluteFilesystemPath(body.path))) {
    return {
      statusCode: 400,
      body: { error: 'path required; worktreeId required for repo-relative paths' },
    };
  }
  const resolved = await resolveNavigateTargetRouteResult({
    requestedPath: body.path,
    requestedWorktreeId: body.worktreeId,
    worktreeIdResolver: deps.resolveWorktreeIdByPathForNavigate,
  });
  if ('statusCode' in resolved) return resolved;

  const { path, worktreeId, canonicalization } = resolved.target;
  if (canonicalization.fallback) {
    deps.warn(
      { worktreeId: body.worktreeId, canonicalWorktreeId: worktreeId, fallback: canonicalization.fallback },
      'workspace navigate worktreeId canonicalization fallback',
    );
  }
  const action = body.action ?? 'reveal';
  const eventData = {
    path,
    worktreeId,
    action,
    line: body.line,
    threadId: body.threadId,
    eventId: randomUUID(),
  };
  const delivery = await emitWorkspaceNavigate(deps, eventData, [`worktree:${worktreeId}`, 'workspace:global']);
  deps.auditLog
    .append({
      type: AuditEventTypes.WORKSPACE_NAVIGATE,
      threadId: body.threadId,
      data: {
        worktreeId,
        requestedWorktreeId: body.worktreeId,
        worktreeIdCanonicalized: canonicalization.canonicalized,
        ...(canonicalization.fallback ? { canonicalizeFallback: canonicalization.fallback } : {}),
        path,
        action,
        line: body.line,
        catId: body.catId,
      },
    })
    .catch(() => {});
  return {
    statusCode: 200,
    body: {
      ok: true,
      path,
      action,
      worktreeId,
      worktreeIdCanonicalized: canonicalization.canonicalized,
      ...(canonicalization.fallback ? { canonicalizeFallback: true } : {}),
      ...delivery,
    },
  };
}

export async function handleWorkspaceNavigateBody(
  body: WorkspaceNavigateBody,
  deps: WorkspaceNavigateDeps,
): Promise<WorkspaceNavigateRouteResult> {
  return body.action === 'knowledge-feed' ? handleKnowledgeFeed(body, deps) : handleFileNavigation(body, deps);
}
