import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FindingBindingV1Schema, ResolvedRepairTargetV1Schema } from '../friction/friction-finding-artifact.js';
import { isFrictionVerdictHandoffPacketV3, type VerdictHandoffPacket } from '../verdict-handoff.js';

export const LIFECYCLE_ROOT_FILENAME = 'lifecycle-root.json';

const lifecycleRootBaseSchema = z.object({
  verdictId: z.string().trim().min(1),
  domainId: z.string().regex(/^eval:[a-z0-9][a-z0-9-]*$/),
  createdAt: z.string().datetime({ offset: true }),
  verdict: z.enum(['delete_sunset', 'build', 'fix', 'keep_observe']),
  harnessUnderEval: z
    .object({
      featureId: z.string().trim().min(1),
      componentId: z.string().trim().min(1),
      name: z.string().trim().min(1),
    })
    .strict(),
  ownerAsk: z
    .object({
      targetFeatureId: z.string().trim().min(1),
      targetOwnerCatId: z.string().trim().min(1),
      requestedAction: z.string().trim().min(1),
    })
    .strict(),
  acceptanceReevalPlan: z
    .object({
      nextEvalAt: z.string().datetime({ offset: true }),
      closureCondition: z.string().trim().min(1),
    })
    .strict(),
});

const lifecycleRootV1Schema = lifecycleRootBaseSchema.extend({ schemaVersion: z.literal(1) }).strict();

const lifecycleRootV2Schema = lifecycleRootBaseSchema
  .extend({
    schemaVersion: z.literal(2),
    caseId: z.string().regex(/^eval-case-v1-[a-f0-9]{64}$/),
    findingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  })
  .strict();

const lifecycleRootV3Schema = lifecycleRootBaseSchema
  .extend({
    schemaVersion: z.literal(3),
    caseId: z.string().regex(/^eval-case-v1-[a-f0-9]{64}$/),
    findingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    findingBinding: FindingBindingV1Schema,
    repairTarget: ResolvedRepairTargetV1Schema,
    supersedes: z
      .object({
        verdictId: z.string().trim().min(1),
        proposalId: z.string().trim().min(1),
        targetResolutionVersion: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const LifecycleRootArtifactSchema = z
  .discriminatedUnion('schemaVersion', [lifecycleRootV1Schema, lifecycleRootV2Schema, lifecycleRootV3Schema])
  .superRefine((root, ctx) => {
    if (root.schemaVersion !== 3) return;
    if (
      root.ownerAsk.targetFeatureId !== root.repairTarget.featureId ||
      root.ownerAsk.targetOwnerCatId !== root.repairTarget.ownerCatId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repairTarget'],
        message: 'ownerAsk must exact-match server-resolved repairTarget',
      });
    }
  });

export type LifecycleRootArtifact = z.infer<typeof LifecycleRootArtifactSchema>;

export function deriveEvalCaseId(domainId: string, findingKey: string): string {
  const digest = createHash('sha256').update(`${domainId}\u001f${findingKey}`, 'utf8').digest('hex');
  return `eval-case-v1-${digest}`;
}

export function buildLifecycleRootArtifact(packet: VerdictHandoffPacket): LifecycleRootArtifact {
  const frictionChild = isFrictionVerdictHandoffPacketV3(packet);
  return LifecycleRootArtifactSchema.parse({
    schemaVersion: frictionChild ? 3 : packet.findingKey ? 2 : 1,
    ...(packet.findingKey
      ? {
          caseId: deriveEvalCaseId(packet.domainId, packet.findingKey),
          findingKey: packet.findingKey,
        }
      : {}),
    ...(frictionChild
      ? {
          findingBinding: packet.findingBinding,
          repairTarget: packet.repairTarget,
        }
      : {}),
    verdictId: packet.id,
    domainId: packet.domainId,
    createdAt: packet.createdAt,
    verdict: packet.verdict,
    harnessUnderEval: {
      featureId: packet.harnessUnderEval.featureId,
      componentId: packet.harnessUnderEval.componentId,
      name: packet.harnessUnderEval.name,
    },
    ownerAsk: {
      targetFeatureId: packet.ownerAsk.targetFeatureId,
      targetOwnerCatId: packet.ownerAsk.targetOwnerCatId,
      requestedAction: packet.ownerAsk.requestedAction,
    },
    acceptanceReevalPlan: {
      nextEvalAt: packet.acceptanceReevalPlan.nextEvalAt,
      closureCondition: packet.acceptanceReevalPlan.closureCondition,
    },
  });
}

export function digestLifecycleRootArtifact(artifact: LifecycleRootArtifact): string {
  const parsed = LifecycleRootArtifactSchema.parse(artifact);
  return createHash('sha256')
    .update(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    .digest('hex');
}

export function assertCompatibleFrictionLifecycleRootReplay(
  existing: LifecycleRootArtifact,
  replay: LifecycleRootArtifact,
): void {
  if (existing.schemaVersion !== 3 || replay.schemaVersion !== 3) {
    throw new Error('friction lifecycle replay compatibility requires schema-v3 roots');
  }
  if (existing.caseId !== replay.caseId) throw new Error('friction lifecycle replay case mismatch');
  if (existing.verdictId !== replay.verdictId) return;
  if (existing.repairTarget.version !== replay.repairTarget.version) return;
  if (digestLifecycleRootArtifact(existing) !== digestLifecycleRootArtifact(replay)) {
    throw new Error(`same-version drift for friction lifecycle case ${existing.caseId}`);
  }
}

export function writeLifecycleRootArtifact(bundleDir: string, packet: VerdictHandoffPacket): LifecycleRootArtifact {
  const artifact = buildLifecycleRootArtifact(packet);
  writeFileSync(join(bundleDir, LIFECYCLE_ROOT_FILENAME), `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return artifact;
}

export function readLifecycleRootArtifact(bundleDir: string): LifecycleRootArtifact {
  const path = join(bundleDir, LIFECYCLE_ROOT_FILENAME);
  return LifecycleRootArtifactSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function checkBundleDirectory(root: LifecycleRootArtifact, directoryName: string): LifecycleRootArtifact {
  if (root.verdictId !== directoryName) {
    throw new Error(`lifecycle root verdictId ${root.verdictId} does not match bundle directory ${directoryName}`);
  }
  return root;
}

export function scanLifecycleRootArtifacts(harnessFeedbackRoot: string): LifecycleRootArtifact[] {
  const bundlesDir = join(harnessFeedbackRoot, 'bundles');
  if (!existsSync(bundlesDir)) return [];

  const roots: LifecycleRootArtifact[] = [];
  for (const entry of readdirSync(bundlesDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const bundleDir = join(bundlesDir, entry.name);
    if (!existsSync(join(bundleDir, LIFECYCLE_ROOT_FILENAME))) continue;
    roots.push(checkBundleDirectory(readLifecycleRootArtifact(bundleDir), entry.name));
  }
  return roots;
}

async function existsAsync(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Same validated, ordered roots as the CLI scan, with bounded nonblocking IO for request readers. */
export async function scanLifecycleRootArtifactsAsync(harnessFeedbackRoot: string): Promise<LifecycleRootArtifact[]> {
  const bundlesDir = join(harnessFeedbackRoot, 'bundles');
  if (!(await existsAsync(bundlesDir))) return [];
  const entries = (await readdir(bundlesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const roots: LifecycleRootArtifact[] = [];
  const batchSize = 16;
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = await Promise.all(
      entries.slice(start, start + batchSize).map(async (entry) => {
        const path = join(bundlesDir, entry.name, LIFECYCLE_ROOT_FILENAME);
        if (!(await existsAsync(path))) return undefined;
        const root = LifecycleRootArtifactSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        return checkBundleDirectory(root, entry.name);
      }),
    );
    for (const root of batch) if (root) roots.push(root);
  }
  return roots;
}
