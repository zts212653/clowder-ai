import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionableFrictionCandidate, ReferenceOnlyFrictionCluster } from '@cat-cafe/shared';

/**
 * How the raw report can be opened. It follows the verdict's own source: a
 * repository verdict points at a workspace file, while a runtime artifact's report
 * is opened through the artifact route with the `friction-report` file key.
 */
export type EvalHubFrictionReportSource = { kind: 'workspace'; rawReportPath: string } | { kind: 'artifact' };

export interface EvalHubFrictionProjection {
  projectionStatus: 'available' | 'unavailable';
  actionableCandidates: ActionableFrictionCandidate[];
  referenceOnly: ReferenceOnlyFrictionCluster[];
  source?: EvalHubFrictionReportSource;
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
  reportSource: (rawReportPath: string) => EvalHubFrictionReportSource,
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

  const source = reportSource(rawReportPath);
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
