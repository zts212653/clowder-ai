import type { EvalEvidenceFileKey, EvalHubFrictionProjection, EvalHubItemSource } from '../HubEvalTypes';

export const EVIDENCE_FILE_LABELS: Record<EvalEvidenceFileKey, string> = {
  verdict: '结论文件',
  snapshot: '快照包',
  attribution: '归因包',
  'friction-report': '原始报告',
};

/**
 * One evidence file the operator asked to open. A repository verdict opens in the
 * workspace; a runtime verdict is read through the owner-scoped artifact route,
 * because it lives outside every workspace. One artifact can hold several verdicts,
 * so a runtime target names both the artifact and the verdict inside it.
 */
export type EvalEvidenceTarget =
  | { kind: 'workspace'; path: string }
  | { kind: 'artifact'; domainSlug: string; artifactId: string; verdictId: string; fileKey: EvalEvidenceFileKey };

const WORKSPACE_BUNDLE_FILES: Record<Exclude<EvalEvidenceFileKey, 'verdict' | 'friction-report'>, string> = {
  snapshot: 'snapshot.json',
  attribution: 'attribution.json',
};

function artifactTarget(
  source: Extract<EvalHubItemSource, { kind: 'artifact' }>,
  fileKey: EvalEvidenceFileKey,
): EvalEvidenceTarget {
  return {
    kind: 'artifact',
    domainSlug: source.domainSlug,
    artifactId: source.artifactId,
    verdictId: source.verdictId,
    fileKey,
  };
}

export function verdictEvidenceTarget(
  source: EvalHubItemSource,
  fileKey: 'verdict' | 'snapshot' | 'attribution',
): EvalEvidenceTarget {
  if (source.kind === 'artifact') return artifactTarget(source, fileKey);
  return {
    kind: 'workspace',
    path: fileKey === 'verdict' ? source.verdictPath : `${source.bundleDir}/${WORKSPACE_BUNDLE_FILES[fileKey]}`,
  };
}

/** The friction raw report, when the projection says there is one to open. */
export function frictionReportTarget(
  source: EvalHubItemSource,
  friction: EvalHubFrictionProjection | undefined,
): EvalEvidenceTarget | null {
  const reportSource = friction?.source;
  if (!reportSource) return null;
  if (reportSource.kind === 'workspace') return { kind: 'workspace', path: reportSource.rawReportPath };
  if (source.kind !== 'artifact') return null;
  return artifactTarget(source, 'friction-report');
}

export function artifactEvidenceUrl(target: Extract<EvalEvidenceTarget, { kind: 'artifact' }>): string {
  const segments = [target.domainSlug, target.artifactId, 'verdicts', target.verdictId, 'files', target.fileKey];
  return `/api/eval-hub/artifacts/${segments.map(encodeURIComponent).join('/')}`;
}
