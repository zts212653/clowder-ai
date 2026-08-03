import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

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

export const LifecycleRootArtifactSchema = z.discriminatedUnion('schemaVersion', [
  lifecycleRootV1Schema,
  lifecycleRootV2Schema,
]);

export type LifecycleRootArtifact = z.infer<typeof LifecycleRootArtifactSchema>;

export function deriveEvalCaseId(domainId: string, findingKey: string): string {
  const digest = createHash('sha256').update(`${domainId}\u001f${findingKey}`, 'utf8').digest('hex');
  return `eval-case-v1-${digest}`;
}

export function buildLifecycleRootArtifact(packet: VerdictHandoffPacket): LifecycleRootArtifact {
  return LifecycleRootArtifactSchema.parse({
    schemaVersion: packet.findingKey ? 2 : 1,
    ...(packet.findingKey
      ? {
          caseId: deriveEvalCaseId(packet.domainId, packet.findingKey),
          findingKey: packet.findingKey,
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
    const root = readLifecycleRootArtifact(bundleDir);
    if (root.verdictId !== entry.name) {
      throw new Error(`lifecycle root verdictId ${root.verdictId} does not match bundle directory ${entry.name}`);
    }
    roots.push(root);
  }
  return roots;
}
