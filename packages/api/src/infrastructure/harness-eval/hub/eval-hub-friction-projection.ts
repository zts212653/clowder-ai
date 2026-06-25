import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ActionableFrictionCandidate, ReferenceOnlyFrictionCluster } from '@cat-cafe/shared';

export interface EvalHubFrictionProjection {
  projectionStatus: 'available' | 'unavailable';
  actionableCandidates: ActionableFrictionCandidate[];
  referenceOnly: ReferenceOnlyFrictionCluster[];
  source?: {
    rawReportPath: string;
  };
}

interface FrictionRawReportPayload {
  report?: {
    actionableCandidates?: unknown;
    referenceOnly?: unknown;
  };
}

export function loadEvalHubFrictionProjection(
  domainId: string,
  bundleDir: string,
  repoRoot: string,
): EvalHubFrictionProjection | undefined {
  if (domainId !== 'eval:friction') return undefined;

  const rawReportPath = join(bundleDir, 'raw', 'rollup-report.json');
  if (!existsSync(rawReportPath)) {
    return {
      projectionStatus: 'unavailable',
      actionableCandidates: [],
      referenceOnly: [],
    };
  }

  const source = { rawReportPath: relative(repoRoot, rawReportPath).replaceAll('\\', '/') };
  try {
    const parsed = JSON.parse(readFileSync(rawReportPath, 'utf8')) as FrictionRawReportPayload;
    const actionableCandidates = Array.isArray(parsed?.report?.actionableCandidates)
      ? (parsed.report.actionableCandidates as ActionableFrictionCandidate[])
      : null;
    const referenceOnly = Array.isArray(parsed?.report?.referenceOnly)
      ? (parsed.report.referenceOnly as ReferenceOnlyFrictionCluster[])
      : null;
    if (!actionableCandidates || !referenceOnly) {
      return {
        projectionStatus: 'unavailable',
        actionableCandidates: [],
        referenceOnly: [],
        source,
      };
    }
    return {
      projectionStatus: 'available',
      actionableCandidates,
      referenceOnly,
      source,
    };
  } catch {
    return {
      projectionStatus: 'unavailable',
      actionableCandidates: [],
      referenceOnly: [],
      source,
    };
  }
}
