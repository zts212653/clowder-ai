import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'yaml';
import { z } from 'zod';

import { FrozenRejudgeSourceMapSchema } from './measurement-independent-rejudge-cohort.js';
import type { CheckedArtifact } from './measurement-independent-rejudge-judgment.js';

const SOURCE_MAP_REF = 'docs/harness-feedback/rejudge-source-maps/f267-friction-2026-07-18-to-24.yaml';

const BaselineMeasurementSchema = z
  .object({
    decision: z
      .object({
        status: z.enum(['usable', 'insufficient']),
      })
      .passthrough(),
  })
  .passthrough();

export interface FrictionBaselineSourceInput {
  itemId: string;
  ref: string;
  bytes: Uint8Array;
}

export interface FrictionBaselineRow {
  itemId: string;
  decision: 'usable' | 'insufficient';
  action: 'keep_observe';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseSourceMap(artifact: CheckedArtifact): z.infer<typeof FrozenRejudgeSourceMapSchema> {
  if (artifact.ref !== SOURCE_MAP_REF) throw new Error('unexpected frozen rejudge source-map ref');
  const parsed = FrozenRejudgeSourceMapSchema.parse(parse(Buffer.from(artifact.bytes).toString('utf8')));
  if (artifact.value !== undefined && !isDeepStrictEqual(artifact.value, parsed)) {
    throw new Error('source-map parsed value does not match exact artifact bytes');
  }
  return parsed;
}

function parseMeasurement(input: FrictionBaselineSourceInput): z.infer<typeof BaselineMeasurementSchema> {
  try {
    return BaselineMeasurementSchema.parse(JSON.parse(Buffer.from(input.bytes).toString('utf8')));
  } catch (error) {
    throw new Error(`invalid baseline measurement for ${input.itemId}`, { cause: error });
  }
}

export function buildFrictionBaselineRows(
  sourceMapArtifact: CheckedArtifact,
  sourceInputs: readonly FrictionBaselineSourceInput[],
): FrictionBaselineRow[] {
  const sourceMap = parseSourceMap(sourceMapArtifact);
  if (sourceInputs.length !== sourceMap.items.length) throw new Error('baseline source coverage mismatch');

  return sourceMap.items.map((mapped, index) => {
    const input = sourceInputs[index];
    if (
      input?.itemId !== mapped.itemId ||
      input.ref !== mapped.measurementSource.ref ||
      sha256(input.bytes) !== mapped.measurementSource.sha256
    ) {
      throw new Error(`baseline source identity mismatch for ${mapped.itemId}`);
    }
    const measurement = parseMeasurement(input);
    if (measurement.decision.status !== 'insufficient') {
      throw new Error(`baseline action is not derivable for usable item ${mapped.itemId}`);
    }
    return {
      itemId: mapped.itemId,
      decision: measurement.decision.status,
      action: 'keep_observe',
    };
  });
}
