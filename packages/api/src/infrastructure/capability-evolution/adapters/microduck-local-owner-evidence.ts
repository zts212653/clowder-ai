import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ExactAssetVersionRefV1 } from '../change/program-lineage.js';
import type { MicroduckBlocked } from './microduck-owner-contract.js';

const OWNER_CONTRACT_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/manifests/owner-contract.json';
const POLICIES_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/manifests/policies.json';
const SMOKE_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/evidence/baseline-onnx-smoke.json';
const GO_NO_GO_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/evidence/go-no-go.json';
const CAPTURE_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/evidence/baseline-space-live.png';
const PATHS = {
  contract: OWNER_CONTRACT_PATH,
  policies: POLICIES_PATH,
  smoke: SMOKE_PATH,
  goNoGo: GO_NO_GO_PATH,
  capture: CAPTURE_PATH,
} as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const ownerPolicy = z.string().regex(/^hf-space:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[a-f0-9]{40}#\S+\.onnx$/u);
const contractSchema = z.object({
  schemaVersion: z.literal(1),
  ownerFeatureId: z.literal('microduck-owner'),
  targetRef: z.literal('microduck-owner:simulator:walking'),
  examplesAreEvidence: z.literal(false),
  policyManifestPath: z.literal(POLICIES_PATH),
});
const policySchema = z.object({
  schemaVersion: z.literal(1),
  defaultPolicy: z.literal('baseline'),
  policies: z.array(
    z.object({
      id: z.string(),
      available: z.boolean(),
      ownerRef: ownerPolicy.nullable(),
      ownerRevision: revision.nullable(),
      url: z.string().url().nullable(),
      sha256: sha256.nullable(),
    }),
  ),
});
const smokeBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('onnx_contract_smoke'),
    status: z.literal('passed'),
    ownerRef: ownerPolicy,
    ownerRevision: revision,
    sha256,
    input: z
      .object({
        name: z.literal('obs'),
        shape: z.tuple([z.literal(1), z.literal(61)]),
        type: z.literal('tensor(float)'),
      })
      .strict(),
    output: z
      .object({
        name: z.literal('actions'),
        shape: z.tuple([z.literal(1), z.literal(14)]),
        type: z.literal('tensor(float)'),
      })
      .strict(),
    zeroObservationAction: z
      .object({
        finite: z.literal(true),
        minimum: z.number().finite(),
        maximum: z.number().finite(),
      })
      .strict(),
  })
  .strict();
const smokeSchema = smokeBodySchema.extend({ receiptSha256: sha256 });
const goNoGoSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: z.literal('partial-go'),
  currentGoal: z.object({
    id: z.literal('local-baseline-observation'),
    budget: z.literal('zero'),
    verdict: z.literal('go'),
    blockers: z.tuple([]),
    claimBoundary: z.string().regex(/no training or robustness claim/u),
  }),
  futureNewPolicyTraining: z.object({ status: z.literal('not-requested'), requirements: z.array(z.unknown()) }),
  runnableBaseline: z.object({
    status: z.literal('passed'),
    onnxReceiptRef: z.literal('./baseline-onnx-smoke.json'),
    captureRef: z.literal('./baseline-space-live.png'),
    captureSha256: sha256,
    claimBoundary: z.string().regex(/not a robustness evaluation/u),
  }),
});

export interface MicroduckLocalEvidenceOptions {
  repoRoot: string;
  readText?: (path: string) => Promise<string>;
  readBytes?: (path: string) => Promise<Uint8Array>;
}

export interface MicroduckLocalEvidence {
  status: 'resolved';
  targetVersionRef: ExactAssetVersionRefV1;
  baselineVersionRef: ExactAssetVersionRefV1;
  artifactSha256: string;
  captureSha256: string;
  captureBytes: Uint8Array;
  policyUrl: string;
}

const blocked = (code: MicroduckBlocked['code']): MicroduckBlocked => ({ status: 'blocked', code });
const parse = <T>(schema: z.ZodType<T>, text: string): T => schema.parse(JSON.parse(text));

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Smoke receipt contains a non-JSON value');
}

function expectedPolicyUrl(ownerRef: string): string | undefined {
  const match = /^hf-space:([^/]+)\/([^@]+)@([a-f0-9]{40})#(.+)$/u.exec(ownerRef);
  if (!match) return undefined;
  return `https://huggingface.co/spaces/${match[1]}/${match[2]}/resolve/${match[3]}/${match[4]}`;
}

/** Reads the immutable T1 evidence bundle afresh; no result is persisted or promoted to owner truth. */
export async function readMicroduckLocalEvidence(
  options: MicroduckLocalEvidenceOptions,
): Promise<MicroduckLocalEvidence | MicroduckBlocked> {
  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'));
  const readBytes = options.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  try {
    const [contractText, policiesText, smokeText, goNoGoText, captureBytes] = await Promise.all([
      readText(resolve(options.repoRoot, PATHS.contract)),
      readText(resolve(options.repoRoot, PATHS.policies)),
      readText(resolve(options.repoRoot, PATHS.smoke)),
      readText(resolve(options.repoRoot, PATHS.goNoGo)),
      readBytes(resolve(options.repoRoot, PATHS.capture)),
    ]);
    contractSchema.parse(JSON.parse(contractText));
    const policies = parse(policySchema, policiesText);
    const smoke = parse(smokeSchema, smokeText);
    const goNoGo = parse(goNoGoSchema, goNoGoText);
    const { receiptSha256, ...smokeBody } = smoke;
    const computedSmokeReceipt = createHash('sha256')
      .update(`${canonicalJson(smokeBody)}\n`)
      .digest('hex');
    if (receiptSha256 !== computedSmokeReceipt) return blocked('artifact_hash_mismatch');
    const baseline = policies.policies.find((policy) => policy.id === 'baseline');
    if (
      !baseline?.available ||
      !baseline.ownerRef ||
      !baseline.ownerRevision ||
      !baseline.sha256 ||
      !baseline.url ||
      smoke.ownerRef !== baseline.ownerRef ||
      smoke.ownerRevision !== baseline.ownerRevision ||
      smoke.sha256 !== baseline.sha256 ||
      baseline.url !== expectedPolicyUrl(baseline.ownerRef)
    ) {
      return blocked('artifact_hash_mismatch');
    }
    const captureSha256 = createHash('sha256').update(captureBytes).digest('hex');
    if (captureSha256 !== goNoGo.runnableBaseline.captureSha256) return blocked('artifact_hash_mismatch');
    return {
      status: 'resolved',
      targetVersionRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: 'simulator:walking',
        version: baseline.ownerRevision,
        assetKind: 'simulator-policy-slot',
        assetId: 'walking',
      },
      baselineVersionRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: baseline.ownerRef,
        version: baseline.ownerRevision,
        assetKind: 'onnx-policy',
        assetId: 'walking',
      },
      artifactSha256: baseline.sha256,
      captureSha256,
      captureBytes,
      policyUrl: baseline.url,
    };
  } catch {
    return blocked('owner_route_unavailable');
  }
}
