import type {
  CapabilityInvocationTrace,
  CapabilityTrace,
  EvidenceScope,
  NormalizedCapabilityUsageCandidate,
} from './eval-capability-wakeup-types.js';

export function hasLivePreviewForOpportunity(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
): boolean {
  const scope = buildEvidenceScope(trace, current, next);
  return trace.previewAvailability.some((entry) => {
    if (!entry.hasLivePort) return false;
    return matchesScope(
      {
        threadId: trace.threadId,
        catId: trace.catId,
        worktreeId: entry.worktreeId,
        timestamp: entry.observedAt ?? scope.windowEndMs,
      },
      scope,
    );
  });
}

export function collectUsageCandidates(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
): NormalizedCapabilityUsageCandidate[] {
  const invocationIds = new Set([current.invocationId, ...(next ? [next.invocationId] : [])]);
  const normalizedTools = trace.invocations
    .filter((invocation) => invocationIds.has(invocation.invocationId))
    .flatMap((invocation) => invocation.normalizedUsageCandidates);
  return [...normalizedTools, ...trace.normalizedAuditCandidates];
}

export function buildEvidenceScope(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
): EvidenceScope {
  return {
    threadId: trace.threadId,
    catId: trace.catId,
    sessionIds: [trace.sessionId, current.invocationId, ...(next ? [next.invocationId] : [])],
    ...(trace.worktreeId ? { worktreeId: trace.worktreeId } : {}),
    windowStartMs: current.startTime,
    windowEndMs: next?.endTime ?? current.endTime,
  };
}

export function matchesScope(
  candidate: {
    threadId?: string;
    catId?: string;
    worktreeId?: string;
    sessionId?: string;
    timestamp: number;
  },
  scope: EvidenceScope,
  options?: { requireWorktree?: boolean },
): boolean {
  if (!candidate.threadId || candidate.threadId !== scope.threadId) return false;
  if (!candidate.catId || candidate.catId !== scope.catId) return false;
  if (candidate.timestamp < scope.windowStartMs || candidate.timestamp > scope.windowEndMs) return false;
  if (candidate.sessionId && !scope.sessionIds.includes(candidate.sessionId)) return false;
  const requireWorktree = options?.requireWorktree ?? true;
  if (scope.worktreeId) {
    if (!candidate.worktreeId) return !requireWorktree;
    if (candidate.worktreeId !== scope.worktreeId) return false;
  }
  return true;
}

export function canonicalizePathForGlobs(path: string, includeGlobs: string[], excludeGlobs: string[]): string {
  const normalized = path.replace(/\\/g, '/');
  if (matchesAny(normalized, includeGlobs) && !matchesAny(normalized, excludeGlobs)) return normalized;
  const segments = normalized.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(index).join('/');
    if (matchesAny(candidate, includeGlobs) && !matchesAny(candidate, excludeGlobs)) return candidate;
  }
  return normalized;
}

export function matchesAny(path: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const wildcarded = escaped.replace(/\*\*/g, '___DOUBLE_WILDCARD___').replace(/\*/g, '[^/]*');
  const normalized = wildcarded.replace(/___DOUBLE_WILDCARD___/g, '.*');
  return new RegExp(`^${normalized}$`);
}
