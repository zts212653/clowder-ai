import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  isRequestReviewAssetVersionRef,
  REQUEST_REVIEW_EVOLUTION_PROGRAM_ID,
  REQUEST_REVIEW_OWNER_FEATURE_ID,
  REQUEST_REVIEW_TARGET_STATE_REF,
} from '../adapters/request-review/request-review-owner-identity.js';
import type { RequestReviewLineageBinding } from './request-review-lineage-binding-resolver.js';

export const REQUEST_REVIEW_EVAL_REPAIR_OWNER_BINDING_PATH =
  'docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/evolution-program-ba0f4524e49cc879279164d5b272cf8c-eval-repair-owner-binding-v1.yaml' as const;

const bindingSchema = z
  .object({
    kind: z.literal('f100-request-review-eval-repair-owner-binding'),
    schemaVersion: z.literal(1),
    programRef: ownerTruthRefV1Schema,
    targetRef: ownerTruthRefV1Schema,
    lineageBindings: z.array(
      z
        .object({
          programRef: ownerTruthRefV1Schema,
          cycleRef: ownerTruthRefV1Schema,
          interventionRef: ownerTruthRefV1Schema,
          assetVersionRef: z.custom<RequestReviewLineageBinding['assetVersionRef']>(isRequestReviewAssetVersionRef),
          caseActionRef: z
            .string()
            .trim()
            .regex(/^case-action:f266:[^\s]+$/u),
        })
        .strict(),
    ),
    truthBoundary: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export interface RequestReviewEvalRepairOwnerBinding {
  lineageBindings: RequestReviewLineageBinding[];
}

export async function loadRequestReviewEvalRepairOwnerBinding(
  repoRoot: string,
): Promise<RequestReviewEvalRepairOwnerBinding> {
  const binding = bindingSchema.parse(
    parse(await readFile(resolve(repoRoot, REQUEST_REVIEW_EVAL_REPAIR_OWNER_BINDING_PATH), 'utf8')),
  );
  const expectedProgram = {
    ownerFeatureId: 'F311',
    ownerStateRef: REQUEST_REVIEW_EVOLUTION_PROGRAM_ID,
  };
  const expectedTarget = {
    ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
    ownerStateRef: REQUEST_REVIEW_TARGET_STATE_REF,
  };
  if (
    refIdentity(binding.programRef) !== refIdentity(expectedProgram) ||
    refIdentity(binding.targetRef) !== refIdentity(expectedTarget) ||
    binding.lineageBindings.some(
      (candidate) =>
        refIdentity(candidate.programRef) !== refIdentity(binding.programRef) ||
        refIdentity(candidate.interventionRef) !== refIdentity(binding.targetRef),
    )
  ) {
    throw new Error('request-review eval-repair binding diverges from canonical Program/target inputs');
  }
  return { lineageBindings: binding.lineageBindings };
}
