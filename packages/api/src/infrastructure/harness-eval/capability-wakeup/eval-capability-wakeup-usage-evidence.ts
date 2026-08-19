import {
  type ConventionGraphDomainId,
  conventionGraphCoverageKeysCoverChangedFiles,
  conventionGraphCoverageKeysForPaths,
  conventionGraphDomainsForPaths,
  conventionGraphPathsForDomain,
} from '../convention-graph-surfaces.js';
import { canonicalizePathForGlobs, collectUsageWindow, matchesScope } from './eval-capability-wakeup-trials-support.js';
import type {
  CapabilityInvocationTrace,
  CapabilityName,
  CapabilityTrace,
  NormalizedCapabilityUsageCandidate,
} from './eval-capability-wakeup-types.js';

interface ConventionGraphEvidenceState {
  evidence: string[];
  coveredDomains: Set<string>;
  coveredConventionKeysByDomain: Map<ConventionGraphDomainId, Set<string>>;
}

export function capabilityUsageEvidence(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  capability: CapabilityName,
  matchedPaths: string[] = [],
  options: {
    previous?: CapabilityInvocationTrace;
    currentInvocationId?: string;
    evidenceWindow?: 'current_next' | 'pre_change';
    beforeTimestamp?: number;
    beforeTimestampByConventionDomain?: Partial<Record<ConventionGraphDomainId, number>>;
  } = {},
): string[] {
  const { candidates, scope } = collectUsageWindow(trace, current, next, options);
  const requiredDomains =
    capability === 'convention-graph-discovery' ? conventionGraphDomainsForPaths(matchedPaths) : [];
  const state = emptyConventionGraphEvidenceState();
  const matchOptions = { ...options, currentInvocationId: current.invocationId };
  for (const candidate of candidates) {
    if (
      !candidateCountsAsEvidence(candidate, capability, requiredDomains, matchedPaths, trace.worktreeId, matchOptions)
    ) {
      continue;
    }
    if (!matchesScope(candidate, scope)) continue;
    recordCandidateEvidence(state, candidate, requiredDomains);
  }
  if (!requiredDomainsAreCovered(state, capability, requiredDomains, matchedPaths)) return [];
  return [...new Set(state.evidence)];
}

function emptyConventionGraphEvidenceState(): ConventionGraphEvidenceState {
  return {
    evidence: [],
    coveredDomains: new Set<string>(),
    coveredConventionKeysByDomain: new Map<ConventionGraphDomainId, Set<string>>(),
  };
}

function candidateCountsAsEvidence(
  candidate: NormalizedCapabilityUsageCandidate,
  capability: CapabilityName,
  requiredDomains: readonly ConventionGraphDomainId[],
  matchedPaths: readonly string[],
  worktreeId: string | undefined,
  matchOptions: {
    currentInvocationId?: string;
    beforeTimestampByConventionDomain?: Partial<Record<ConventionGraphDomainId, number>>;
  },
): boolean {
  if (!candidateMatchesCapability(candidate, capability, requiredDomains, matchedPaths, matchOptions)) return false;
  if (capability !== 'workspace-navigator') return true;
  return workspaceNavigationMatches(candidate, matchedPaths, worktreeId);
}

function recordCandidateEvidence(
  state: ConventionGraphEvidenceState,
  candidate: NormalizedCapabilityUsageCandidate,
  requiredDomains: readonly ConventionGraphDomainId[],
): void {
  if (candidate.conventionGraphDomain) state.coveredDomains.add(candidate.conventionGraphDomain);
  recordConventionCoverageKeys(state, candidate, requiredDomains);
  state.evidence.push(`${candidate.source}:${candidate.sourceId}`);
}

function recordConventionCoverageKeys(
  state: ConventionGraphEvidenceState,
  candidate: NormalizedCapabilityUsageCandidate,
  requiredDomains: readonly ConventionGraphDomainId[],
): void {
  const domain = candidate.conventionGraphDomain;
  if (!isRequiredConventionGraphDomain(domain, requiredDomains)) return;
  if (!candidate.conventionGraphCoverageKeys) return;
  let coveredKeys = state.coveredConventionKeysByDomain.get(domain);
  if (!coveredKeys) {
    coveredKeys = new Set<string>();
    state.coveredConventionKeysByDomain.set(domain, coveredKeys);
  }
  for (const key of candidate.conventionGraphCoverageKeys) coveredKeys.add(key);
}

function requiredDomainsAreCovered(
  state: ConventionGraphEvidenceState,
  capability: CapabilityName,
  requiredDomains: readonly ConventionGraphDomainId[],
  matchedPaths: readonly string[],
): boolean {
  if (capability === 'convention-graph-discovery' && requiredDomains.length > 0) {
    return requiredDomains.every((domain) => changedFilesAreCoveredByDomainKeys(state, domain, matchedPaths));
  }
  return requiredDomains.every((domain) => state.coveredDomains.has(domain));
}

function changedFilesAreCoveredByDomainKeys(
  state: ConventionGraphEvidenceState,
  domain: ConventionGraphDomainId,
  matchedPaths: readonly string[],
): boolean {
  const coveredKeys = state.coveredConventionKeysByDomain.get(domain);
  return (
    coveredKeys !== undefined && conventionGraphCoverageKeysCoverChangedFiles([...coveredKeys], domain, matchedPaths)
  );
}

function candidateMatchesCapability(
  candidate: NormalizedCapabilityUsageCandidate,
  capability: CapabilityName,
  requiredDomains: readonly ConventionGraphDomainId[],
  matchedPaths: readonly string[],
  options: {
    currentInvocationId?: string;
    beforeTimestampByConventionDomain?: Partial<Record<ConventionGraphDomainId, number>>;
  },
): boolean {
  if (candidate.capability !== capability) return false;
  if (!candidate.successful) return false;
  if (capability !== 'convention-graph-discovery') return true;
  if (requiredDomains.length === 0) return true;
  const domain = candidate.conventionGraphDomain;
  if (!isRequiredConventionGraphDomain(domain, requiredDomains)) return false;
  const domainCutoff = options.beforeTimestampByConventionDomain?.[domain];
  if (
    domainCutoff !== undefined &&
    isCurrentInvocationCandidate(candidate, options.currentInvocationId) &&
    candidate.timestamp >= domainCutoff
  ) {
    return false;
  }
  const expectedKeys = new Set(conventionGraphCoverageKeysForPaths(matchedPaths, domain));
  if (expectedKeys.size === 0) return false;
  if (!candidate.conventionGraphCoverageKeys) return false;
  return candidate.conventionGraphCoverageKeys.some((key) => expectedKeys.has(key));
}

function isCurrentInvocationCandidate(
  candidate: NormalizedCapabilityUsageCandidate,
  currentInvocationId: string | undefined,
): boolean {
  if (candidate.invocationId === undefined) return true;
  return candidate.invocationId === currentInvocationId;
}

function isRequiredConventionGraphDomain(
  domain: string | undefined,
  requiredDomains: readonly ConventionGraphDomainId[],
): domain is ConventionGraphDomainId {
  return domain !== undefined && requiredDomains.includes(domain as ConventionGraphDomainId);
}

function workspaceNavigationMatches(
  candidate: { action?: string; path?: string; worktreeId?: string },
  matchedPaths: readonly string[],
  worktreeId: string | undefined,
): boolean {
  const action = candidate.action;
  if (typeof action === 'string' && action !== 'open' && action !== 'reveal') return false;
  const path = candidate.path;
  if (typeof path === 'string') {
    if (!matchedPaths.includes(path)) return false;
  } else if (matchedPaths.length > 0) {
    return false;
  }
  if (worktreeId && candidate.worktreeId !== worktreeId) return false;
  return true;
}

export function firstMatchedChangeTimestampsByDomain(
  current: CapabilityInvocationTrace,
  matchedFiles: string[],
  includeGlobs: string[],
  excludeGlobs: string[],
  requiredDomains: readonly ConventionGraphDomainId[],
): Partial<Record<ConventionGraphDomainId, number>> {
  const timestamps: Partial<Record<ConventionGraphDomainId, number>> = {};
  for (const domain of requiredDomains) {
    const timestamp = firstMatchedChangeTimestamp(
      current,
      conventionGraphPathsForDomain(matchedFiles, domain),
      includeGlobs,
      excludeGlobs,
    );
    timestamps[domain] = timestamp === undefined ? current.startTime : timestamp;
  }
  return timestamps;
}

export function latestTimestamp(timestamps: (number | undefined)[]): number | undefined {
  const defined = timestamps.filter((timestamp): timestamp is number => typeof timestamp === 'number');
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

export function firstMatchedChangeTimestamp(
  current: CapabilityInvocationTrace,
  matchedFiles: string[],
  includeGlobs: string[],
  excludeGlobs: string[],
): number | undefined {
  const matched = new Set(matchedFiles);
  const timestamps = current.transcriptToolUses
    .filter((toolUse) =>
      toolUse.changedFiles.some((path) => matched.has(canonicalizePathForGlobs(path, includeGlobs, excludeGlobs))),
    )
    .map((toolUse) => toolUse.timestamp);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}
