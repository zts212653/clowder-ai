import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const nullableCountRecordSchema = z.record(z.union([z.number(), z.null()]));
const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const bundleComponentSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    componentName: z.string().min(1).optional(),
    activationCounts: nullableCountRecordSchema.default({}),
    frictionCounts: nullableCountRecordSchema.default({}),
    confidence: z.enum(['no-data', 'low', 'medium', 'high']).default('medium'),
  })
  .transform((component, ctx) => {
    const componentId = component.componentId ?? component.id;
    const componentName = component.componentName ?? component.name;
    if (!componentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bundle snapshot component id is required' });
      return z.NEVER;
    }
    if (!componentName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bundle snapshot component name is required' });
      return z.NEVER;
    }
    return {
      componentId,
      componentName,
      activationCounts: component.activationCounts,
      frictionCounts: component.frictionCounts,
      confidence: component.confidence,
    };
  });

/**
 * Bundle-layer feature id invariant. Both snapshot.json and attribution.json
 * enforce this — generators MUST align their packet/field guards with this
 * regex to fail up-front (clean 400) instead of after writing bundle (500).
 * Cloud Codex R10 P2 surfaced this as a layered consistency requirement.
 */
export const BUNDLE_FEATURE_ID_REGEX = /^F\d{3}$/;

const bundleSnapshotSchema = z.object({
  verdictId: z.string().min(1),
  evalSnapshotId: z.string().min(1),
  featureId: z.string().regex(BUNDLE_FEATURE_ID_REGEX, 'featureId must match F followed by 3 digits'),
  generatedAt: z.string().datetime({ offset: true }),
  window: z.object({
    startMs: z.number().int().optional(),
    endMs: z.number().int().optional(),
    durationHours: z.number().min(0),
  }),
  components: z.array(bundleComponentSchema).min(1),
});

const attributionEvidenceSchema = z.object({
  type: z.string().min(1),
  anchor: z.string().min(1),
  excerpt: z.string().min(1),
});

const attributionFindingSchema = z.object({
  id: z.string().min(1),
  relatedFeature: z.string().min(1).optional(),
  frictionSignal: z.object({
    type: z.string().min(1),
    severity: z.enum(['low', 'medium', 'high']),
    confidence: z.number().min(0).max(1),
    detectedAt: z.string().datetime({ offset: true }).optional(),
  }),
  attribution: z.object({
    primaryLayer: z.string().min(1),
    pipelineOrHuman: z.string().min(1).optional(),
    evidence: z.array(attributionEvidenceSchema),
  }),
  proposedAction: z.array(
    z.object({
      action: z.string().min(1),
      target: z.string().min(1),
      rationale: z.string().min(1),
    }),
  ),
  status: z.string().min(1).optional(),
});

const bundleAttributionSchema = z.object({
  verdictId: z.string().min(1),
  featureId: z.string().regex(BUNDLE_FEATURE_ID_REGEX, 'featureId must match F followed by 3 digits'),
  evalSnapshotId: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  findings: z.array(attributionFindingSchema),
  noFindingRecord: z
    .object({
      reason: z.string().min(1),
      evidence: z.string().min(1),
    })
    .optional(),
});

const bundleProvenanceSchema = z.object({
  verdictId: z.string().min(1),
  rawInputs: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string(),
      }),
    )
    .min(1),
  generatedAt: z.string().datetime({ offset: true }),
  generator: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    commit: z.string().min(1).optional(),
  }),
  sanitizeRulesVersion: z.string().optional(),
});

export interface ResolveA2aEvidenceBundleInput {
  bundleDir: string;
  verdictId: string;
  snapshotRef?: string;
  attributionRefs?: string[];
}

export interface ResolvedA2aEvidenceBundle {
  verdictId: string;
  bundleDir: string;
  snapshotPath: string;
  attributionPath: string;
  provenancePath: string;
  snapshotRef: `snapshot:bundle/${string}/snapshot`;
  attributionRefs: `attribution:bundle/${string}/${string}`[];
  snapshot: z.output<typeof bundleSnapshotSchema>;
  attributionReport: z.output<typeof bundleAttributionSchema>;
  provenance: z.output<typeof bundleProvenanceSchema>;
}

export function resolveA2aEvidenceBundle(input: ResolveA2aEvidenceBundleInput): ResolvedA2aEvidenceBundle {
  const snapshotPath = join(input.bundleDir, 'snapshot.json');
  const attributionPath = join(input.bundleDir, 'attribution.json');
  const provenancePath = join(input.bundleDir, 'provenance.json');
  const snapshot = bundleSnapshotSchema.parse(readJson(snapshotPath));
  const attributionReport = bundleAttributionSchema.parse(readJson(attributionPath));
  const provenance = bundleProvenanceSchema.parse(readJson(provenancePath));

  assertSameVerdictId(input.verdictId, snapshot.verdictId, 'snapshot');
  assertSameVerdictId(input.verdictId, attributionReport.verdictId, 'attribution');
  assertSameVerdictId(input.verdictId, provenance.verdictId, 'provenance');
  if (snapshot.evalSnapshotId !== attributionReport.evalSnapshotId) {
    throw new Error(
      `bundle eval snapshot mismatch: snapshot=${snapshot.evalSnapshotId} attribution=${attributionReport.evalSnapshotId}`,
    );
  }

  assertProvenance(provenance);
  assertAttributionAnchors(snapshot, attributionReport);

  const snapshotRef = `snapshot:bundle/${input.verdictId}/snapshot` as const;
  const attributionRefs = attributionRefsFor(input.verdictId, attributionReport);
  assertSnapshotRef(input.snapshotRef ?? snapshotRef, input.verdictId);
  for (const attributionRef of input.attributionRefs ?? attributionRefs) {
    assertAttributionRef(attributionRef, input.verdictId, attributionReport);
  }

  return {
    verdictId: input.verdictId,
    bundleDir: input.bundleDir,
    snapshotPath,
    attributionPath,
    provenancePath,
    snapshotRef,
    attributionRefs,
    snapshot,
    attributionReport,
    provenance,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertSameVerdictId(expected: string, actual: string, source: string): void {
  if (expected !== actual) {
    throw new Error(`bundle verdict id mismatch in ${source}: expected=${expected} actual=${actual}`);
  }
}

function assertProvenance(provenance: z.output<typeof bundleProvenanceSchema>): void {
  if (provenance.rawInputs.some((input) => input.sha256.length === 0)) {
    throw new Error('provenance raw input hash is required');
  }
  if (provenance.rawInputs.some((input) => !SHA256_DIGEST_PATTERN.test(input.sha256))) {
    throw new Error('provenance raw input hash must be a 64-char lowercase sha256 digest');
  }
  if (!provenance.sanitizeRulesVersion) {
    throw new Error('provenance sanitize rules version is required');
  }
}

function assertAttributionAnchors(
  snapshot: z.output<typeof bundleSnapshotSchema>,
  attributionReport: z.output<typeof bundleAttributionSchema>,
): void {
  for (const finding of attributionReport.findings) {
    let hasBundledComponentEvidence = false;
    for (const evidence of finding.attribution.evidence) {
      const component = componentForEvidenceAnchor(snapshot.components, evidence.anchor);
      if (!component) {
        if (looksLikeComponentMetricAnchor(evidence)) {
          throw new Error('attribution evidence anchor does not match bundled snapshot components');
        }
        continue;
      }
      const metricKey = metricKeyForEvidenceAnchor(component.componentId, evidence.anchor);
      if (!metricKey) {
        if (requiresComponentMetricKey(evidence)) {
          throw new Error('attribution evidence anchor must include a metric key');
        }
        continue;
      }
      hasBundledComponentEvidence = true;
      if (evidence.type === 'telemetry-gap') continue;
      const componentMetricKeys = new Set([
        ...Object.keys(component.activationCounts),
        ...Object.keys(component.frictionCounts),
      ]);
      if (!componentMetricKeys.has(metricKey)) {
        throw new Error('attribution evidence anchor does not match bundled snapshot metrics');
      }
    }
    if (!hasBundledComponentEvidence) {
      throw new Error('attribution finding must include at least one bundled component evidence anchor');
    }
  }
}

function componentForEvidenceAnchor(
  components: z.output<typeof bundleSnapshotSchema>['components'],
  anchor: string,
): z.output<typeof bundleSnapshotSchema>['components'][number] | undefined {
  return components.find(
    (component) => anchor === component.componentId || anchor.startsWith(`${component.componentId}/`),
  );
}

function metricKeyForEvidenceAnchor(componentId: string, anchor: string): string | undefined {
  if (anchor === componentId) return undefined;
  const rest = anchor.slice(componentId.length + 1);
  // 砚砚 cross-thread BLOCKER (thread_eval_a2a 2026-06-15T03:00Z): PR #2144/#2222/#2250
  // started writing per-fire sample evidence rows of shape
  // `<componentId>/<base_metric>/<sampleHash>` (e.g. `C2/c2.verdict_without_pass_count/f7c5de78f39dc5fc`).
  // Snapshot metric keys (activationCounts + frictionCounts) are plain
  // `<base_metric>` strings — no slashes. Strip the `/<sampleHash>` suffix here
  // so sampled anchors validate against the same base metric key set the
  // aggregate row uses. Without this, `assertAttributionAnchors` rejects every
  // valid sampled-finding bundle with "anchor does not match bundled snapshot
  // metrics" and publish_verdict returns 500 generator_failed.
  //
  // Cloud Codex R1 P2: enforce EXACTLY ONE sample suffix segment. The resolver
  // is the fail-closed bundle-integrity gate before publish; malformed refs
  // like `<base>/<foo>/<bar>` must not be silently normalized into the valid
  // `<base>` shape and forwarded in `sampleTraceRefs`. Throw on any extra
  // path segments past the documented one-suffix shape.
  const sampleSeparator = rest.indexOf('/');
  if (sampleSeparator < 0) return rest;
  const sampleSuffix = rest.slice(sampleSeparator + 1);
  // Valid sample shape: exactly one non-empty `/<sampleHash>` segment past the
  // component/metric prefix. Cloud Codex R1 P2 caught multi-segment garbage;
  // R2 P2 caught the empty-suffix case (trailing slash like `<base>/`) where
  // `sampleSuffix.includes('/')` returned false and silently stripped the
  // empty suffix → publish forwarded an invalid ref into `sampleTraceRefs`.
  if (sampleSuffix.length === 0 || sampleSuffix.includes('/')) {
    throw new Error(
      'attribution evidence anchor has malformed sample suffix (expected exactly one non-empty /<sampleHash> segment past the component/metric prefix)',
    );
  }
  return rest.slice(0, sampleSeparator);
}

function looksLikeComponentMetricAnchor(evidence: z.output<typeof attributionEvidenceSchema>): boolean {
  if (evidence.type !== 'counter' && evidence.type !== 'telemetry-gap') return false;
  const separatorIndex = evidence.anchor.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === evidence.anchor.length - 1) return false;
  const componentId = evidence.anchor.slice(0, separatorIndex);
  return !componentId.includes(':');
}

function requiresComponentMetricKey(evidence: z.output<typeof attributionEvidenceSchema>): boolean {
  return evidence.type === 'counter' || evidence.type === 'telemetry-gap';
}

function attributionRefsFor(
  verdictId: string,
  attributionReport: z.output<typeof bundleAttributionSchema>,
): `attribution:bundle/${string}/${string}`[] {
  if (attributionReport.findings.length > 0) {
    return attributionReport.findings.map((finding) => `attribution:bundle/${verdictId}/${finding.id}` as const);
  }
  if (!attributionReport.noFindingRecord) {
    throw new Error('no-finding record is required before emitting no-finding attribution ref');
  }
  return [`attribution:bundle/${verdictId}/${attributionReport.evalSnapshotId}:no-finding` as const];
}

function assertSnapshotRef(ref: string, verdictId: string): void {
  if (ref !== `snapshot:bundle/${verdictId}/snapshot`) {
    throw new Error('snapshot ref must resolve to committed bundle');
  }
}

function assertAttributionRef(
  ref: string,
  verdictId: string,
  attributionReport: z.output<typeof bundleAttributionSchema>,
): void {
  if (!ref.startsWith(`attribution:bundle/${verdictId}/`)) {
    throw new Error('attribution ref must resolve to committed bundle');
  }
  const allowedRefs = new Set(attributionRefsFor(verdictId, attributionReport));
  if (!allowedRefs.has(ref as `attribution:bundle/${string}/${string}`)) {
    throw new Error('attribution ref does not resolve to a bundled finding');
  }
}
