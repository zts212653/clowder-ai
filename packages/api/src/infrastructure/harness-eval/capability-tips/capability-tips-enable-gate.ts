import { z } from 'zod';

import { parseMeasurementBundleCertificate } from '../measurement/measurement-bundle-validation.js';

export interface CapabilityTipsEnableDomain {
  domainId: string;
  enabled?: boolean;
}

export interface CapabilityTipsEnableEvidence {
  domainId: string;
  f267CertificateRef: string | null;
  pipelineReplayRef: string | null;
}

export type CapabilityTipsEnableArtifactReader = (ref: string) => unknown | undefined;

const gitRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/, 'sourceRevision must be a full Git SHA');
const generatedAtSchema = z.string().datetime({ offset: true });

const pipelineReplaySchema = z
  .object({
    kind: z.literal('f268-capability-tips-pipeline-replay'),
    schemaVersion: z.literal(1),
    domainId: z.literal('eval:capability-tips'),
    status: z.literal('passed'),
    provenance: z
      .object({
        featureId: z.literal('F268'),
        sourceRevision: gitRevisionSchema,
        generatedAt: generatedAtSchema,
      })
      .strict(),
    checks: z
      .object({
        authenticatedIngress: z.literal(true),
        durableReceipt: z.literal(true),
        duplicateRetryNoRecount: z.literal(true),
        aggregateReadback: z.literal(true),
        sourceAdapterProjection: z.literal(true),
      })
      .strict(),
  })
  .strict();

/**
 * AC-B4 guard. Disabled domains are valid without evidence. Enabling requires
 * typed, passed, provenance-bearing F267 and F268 artifacts at their canonical
 * in-repo locations; mere file existence is intentionally insufficient.
 */
export function validateCapabilityTipsEnablement(
  domain: CapabilityTipsEnableDomain,
  evidence: CapabilityTipsEnableEvidence,
  readArtifact: CapabilityTipsEnableArtifactReader,
): string | null {
  if (domain.domainId !== 'eval:capability-tips' || evidence.domainId !== domain.domainId) {
    return 'domainId must be eval:capability-tips in both domain and enable-gate evidence';
  }
  if (domain.enabled !== true) return null;

  const certificateRef = evidence.f267CertificateRef;
  const replayRef = evidence.pipelineReplayRef;
  if (!certificateRef && !replayRef) {
    return 'eval:capability-tips cannot be enabled: missing F267 certificate and pipeline replay';
  }
  if (!certificateRef) return 'eval:capability-tips cannot be enabled: missing F267 certificate';
  if (!replayRef) return 'eval:capability-tips cannot be enabled: missing pipeline replay';

  const certificateError = validateArtifact(
    'F267 certificate',
    certificateRef,
    'docs/harness-feedback/certificates/',
    (artifact) => {
      const certificate = parseMeasurementBundleCertificate(artifact);
      if (certificate.domainId !== 'eval:capability-tips') {
        throw new Error('domainId must be eval:capability-tips');
      }
    },
    readArtifact,
  );
  if (certificateError) return certificateError;

  return validateArtifact(
    'F268 pipeline replay',
    replayRef,
    'docs/harness-feedback/replays/',
    (artifact) => pipelineReplaySchema.parse(artifact),
    readArtifact,
  );
}

function validateArtifact(
  label: string,
  ref: string,
  canonicalRoot: string,
  parseArtifact: (artifact: unknown) => unknown,
  readArtifact: CapabilityTipsEnableArtifactReader,
): string | null {
  if (!isSafeEvidenceRef(ref, canonicalRoot)) {
    return `${label} ref must be a safe YAML path under ${canonicalRoot}: ${ref}`;
  }

  const artifact = readArtifact(ref);
  if (artifact === undefined) return `${label} artifact does not exist: ${ref}`;

  try {
    parseArtifact(artifact);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const location = issue?.path.length ? issue.path.join('.') : 'root';
      return `${label} is not a valid typed evidence artifact (${location}: ${issue?.message ?? 'invalid'})`;
    }
    return `${label} is not a valid typed evidence artifact (${error instanceof Error ? error.message : String(error)})`;
  }
  return null;
}

function isSafeEvidenceRef(ref: string, canonicalRoot: string): boolean {
  return (
    ref.startsWith(canonicalRoot) &&
    ref.endsWith('.yaml') &&
    !ref.startsWith('/') &&
    !ref.includes('..') &&
    !ref.includes('\\') &&
    !ref.includes('\0')
  );
}
