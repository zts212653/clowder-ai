import { createHash } from 'node:crypto';

import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const OpaqueItemIdSchema = z.string().regex(/^item-\d{3}$/);
const WindowSchema = z
  .object({
    startMs: z.number().int(),
    endMs: z.number().int(),
  })
  .strict();

const FrozenRejudgeSourceSchema = z
  .object({
    ref: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict();

export const FrozenRejudgeSourceMapSchema = z
  .object({
    kind: z.literal('f267-frozen-rejudge-source-map'),
    schemaVersion: z.literal(1),
    sourceMapId: z.string().min(1),
    items: z.array(
      z
        .object({
          itemId: OpaqueItemIdSchema,
          measurementSource: FrozenRejudgeSourceSchema,
          rollupSource: FrozenRejudgeSourceSchema,
        })
        .strict(),
    ),
  })
  .strict();

const CancelEvidenceSchema = z
  .object({
    opportunityStatus: z.literal('measured'),
    expectedCount: z.number().int().nonnegative(),
    actualCount: z.number().int().nonnegative(),
    intersectionCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    extraCount: z.number().int().nonnegative(),
    recall: z.number().gte(0).lte(1).nullable(),
  })
  .strict();

export const FrozenRejudgeCohortSchema = z
  .object({
    kind: z.literal('f267-frozen-rejudge-cohort'),
    schemaVersion: z.literal(1),
    cohortId: z.string().min(1),
    selectionContract: z.literal('f267-friction-closed-windows-v1'),
    items: z.array(
      z
        .object({
          itemId: OpaqueItemIdSchema,
          window: WindowSchema,
          sourceDigests: z
            .object({
              measurementSha256: Sha256Schema,
              rollupSha256: Sha256Schema,
            })
            .strict(),
          evidence: z
            .object({
              cancel: CancelEvidenceSchema,
              downstreamDegraded: z.boolean(),
              droppedChannels: z.array(z.string().min(1)),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

const MeasurementSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    measurementTarget: z.literal('friction_opportunity_to_action'),
    window: z
      .object({
        sinceMs: z.number().int(),
        untilMs: z.number().int(),
      })
      .strict(),
    cancelJoin: z
      .object({
        status: z.enum(['complete', 'adapter_gap', 'unexpected_output', 'mismatch', 'no_opportunity', 'unavailable']),
        expectedIds: z.array(z.string()),
        actualIds: z.array(z.string()),
        intersectionIds: z.array(z.string()),
        missingIds: z.array(z.string()),
        extraIds: z.array(z.string()),
        recall: z.number().gte(0).lte(1).nullable(),
      })
      .strict(),
  })
  .passthrough();

const RollupSourceSchema = z
  .object({
    window: z
      .object({
        sinceMs: z.number().int(),
        untilMs: z.number().int(),
      })
      .strict(),
    degraded: z.boolean(),
    droppedChannels: z.array(z.string().min(1)),
  })
  .passthrough();

export type FrozenRejudgeSourceMap = z.infer<typeof FrozenRejudgeSourceMapSchema>;
export type FrozenRejudgeCohort = z.infer<typeof FrozenRejudgeCohortSchema>;

export interface FrozenFrictionRejudgeSourceInput {
  itemId: string;
  measurementSource: { ref: string; bytes: Uint8Array };
  rollupSource: { ref: string; bytes: Uint8Array };
}

export interface FrozenFrictionRejudgeArtifactOptions {
  sourceMapId: string;
  cohortId: string;
}

const FROZEN_SELECTION = [
  {
    itemId: 'item-001',
    measurementRef:
      'docs/harness-feedback/bundles/2026-07-18-eval-friction-manual-recheck-rolling-window-toolgap-watch/raw/measurement-validity.json',
    rollupRef:
      'docs/harness-feedback/bundles/2026-07-18-eval-friction-manual-recheck-rolling-window-toolgap-watch/raw/rollup-report.json',
  },
  {
    itemId: 'item-002',
    measurementRef:
      'docs/harness-feedback/bundles/2026-07-21-eval-friction-overlap-tail-after-routing-guard-watch/raw/measurement-validity.json',
    rollupRef:
      'docs/harness-feedback/bundles/2026-07-21-eval-friction-overlap-tail-after-routing-guard-watch/raw/rollup-report.json',
  },
  {
    itemId: 'item-003',
    measurementRef:
      'docs/harness-feedback/bundles/2026-07-24-eval-friction-singleton-tool-contract-watch/raw/measurement-validity.json',
    rollupRef:
      'docs/harness-feedback/bundles/2026-07-24-eval-friction-singleton-tool-contract-watch/raw/rollup-report.json',
  },
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function assertSafeBundleRef(ref: string, expectedBasename: 'measurement-validity.json' | 'rollup-report.json'): void {
  const exactPattern = new RegExp(`^docs/harness-feedback/bundles/[^/]+/raw/${expectedBasename.replace('.', '\\.')}$`);
  if (
    ref.includes('\0') ||
    ref.includes('\\') ||
    ref.split('/').some((segment) => segment === '.' || segment === '..') ||
    !exactPattern.test(ref)
  ) {
    throw new Error(`unsafe frozen rejudge source ref: ${ref}`);
  }
}

function assertExactSelection(inputs: readonly FrozenFrictionRejudgeSourceInput[]): void {
  if (inputs.length !== FROZEN_SELECTION.length) {
    throw new Error(`frozen rejudge selection requires exactly ${FROZEN_SELECTION.length} items`);
  }
  for (const [index, expected] of FROZEN_SELECTION.entries()) {
    const actual = inputs[index];
    if (
      actual?.itemId !== expected.itemId ||
      actual.measurementSource.ref !== expected.measurementRef ||
      actual.rollupSource.ref !== expected.rollupRef
    ) {
      throw new Error(`frozen rejudge selection mismatch at ${expected.itemId}`);
    }
  }
}

function assertWindowMatches(
  measurement: z.infer<typeof MeasurementSourceSchema>,
  rollup: z.infer<typeof RollupSourceSchema>,
  itemId: string,
): void {
  if (
    measurement.window.sinceMs !== rollup.window.sinceMs ||
    measurement.window.untilMs !== rollup.window.untilMs ||
    measurement.window.sinceMs >= measurement.window.untilMs
  ) {
    throw new Error(`measurement and rollup windows do not match for ${itemId}`);
  }
}

export function buildFrozenFrictionRejudgeArtifacts(
  input: readonly FrozenFrictionRejudgeSourceInput[],
  options: FrozenFrictionRejudgeArtifactOptions,
): { sourceMap: FrozenRejudgeSourceMap; cohort: FrozenRejudgeCohort } {
  const inputs = [...input].sort((left, right) => left.itemId.localeCompare(right.itemId));
  assertExactSelection(inputs);

  const sourceItems: FrozenRejudgeSourceMap['items'] = [];
  const cohortItems: FrozenRejudgeCohort['items'] = [];
  for (const item of inputs) {
    assertSafeBundleRef(item.measurementSource.ref, 'measurement-validity.json');
    assertSafeBundleRef(item.rollupSource.ref, 'rollup-report.json');

    const measurement = MeasurementSourceSchema.parse(
      parseJson(item.measurementSource.bytes, `${item.itemId} measurement source`),
    );
    const rollup = RollupSourceSchema.parse(parseJson(item.rollupSource.bytes, `${item.itemId} rollup source`));
    assertWindowMatches(measurement, rollup, item.itemId);

    const measurementSha256 = sha256(item.measurementSource.bytes);
    const rollupSha256 = sha256(item.rollupSource.bytes);
    sourceItems.push({
      itemId: item.itemId,
      measurementSource: { ref: item.measurementSource.ref, sha256: measurementSha256 },
      rollupSource: { ref: item.rollupSource.ref, sha256: rollupSha256 },
    });
    cohortItems.push({
      itemId: item.itemId,
      window: { startMs: measurement.window.sinceMs, endMs: measurement.window.untilMs },
      sourceDigests: { measurementSha256, rollupSha256 },
      evidence: {
        cancel: {
          opportunityStatus: 'measured',
          expectedCount: measurement.cancelJoin.expectedIds.length,
          actualCount: measurement.cancelJoin.actualIds.length,
          intersectionCount: measurement.cancelJoin.intersectionIds.length,
          missingCount: measurement.cancelJoin.missingIds.length,
          extraCount: measurement.cancelJoin.extraIds.length,
          recall: measurement.cancelJoin.recall,
        },
        downstreamDegraded: rollup.degraded,
        droppedChannels: [...new Set(rollup.droppedChannels)].sort(),
      },
    });
  }

  return {
    sourceMap: FrozenRejudgeSourceMapSchema.parse({
      kind: 'f267-frozen-rejudge-source-map',
      schemaVersion: 1,
      sourceMapId: options.sourceMapId,
      items: sourceItems,
    }),
    cohort: FrozenRejudgeCohortSchema.parse({
      kind: 'f267-frozen-rejudge-cohort',
      schemaVersion: 1,
      cohortId: options.cohortId,
      selectionContract: 'f267-friction-closed-windows-v1',
      items: cohortItems,
    }),
  };
}
