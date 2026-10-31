import {
  type ExactAssetVersionRefV1,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { InvocationRecord } from '../../../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type {
  CanonicalRepairDispatchInput,
  CanonicalRepairDispatchOutcome,
  EvalRepairAuthenticatedPrincipal,
  EvalRepairOwnerLineage,
} from '../../harness-eval/eval-repair-approval-contracts.js';
import type {
  EvalRepairFreshOutcomeReceipt,
  EvalRepairInterventionReceipt,
} from '../../harness-eval/eval-repair-outcome-contracts.js';
import type {
  EvalRepairOwnerRuntimeBindingProvider,
  EvalRepairOwnerRuntimeBindings,
} from '../../harness-eval/eval-repair-owner-runtime.js';
import {
  isRequestReviewAssetVersionRef,
  REQUEST_REVIEW_ASSET_ID,
  REQUEST_REVIEW_EVOLUTION_PROGRAM_ID,
  REQUEST_REVIEW_OWNER_FEATURE_ID,
  REQUEST_REVIEW_TARGET_STATE_REF,
} from '../adapters/request-review/request-review-owner-identity.js';

const PROGRAM_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F311',
  ownerStateRef: REQUEST_REVIEW_EVOLUTION_PROGRAM_ID,
});
const TARGET_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
  ownerStateRef: REQUEST_REVIEW_TARGET_STATE_REF,
});

export interface RequestReviewProgramSnapshot {
  program: {
    programId: string;
    objectRef: OwnerTruthRefV1;
    cycle: number;
    valueOwnerRef?: OwnerTruthRefV1;
  };
}

type LineageResolution =
  | { status: 'resolved'; caseActionRef: string }
  | { status: 'blocked'; reason: 'lineage_missing' | 'lineage_ambiguous' | 'lineage_mismatch' };

export interface RequestReviewEvalRepairOwnerProviderOptions {
  ownerUserId: string;
  programReader: { get(programId: string): Promise<RequestReviewProgramSnapshot> };
  invocationRegistry: { peekRecord(invocationId: string): Promise<InvocationRecord | null> };
  versionReader: { currentVersionRef(): Promise<ExactAssetVersionRefV1> };
  lineageBindingResolver: { resolve(lineage: EvalRepairOwnerLineage): Promise<LineageResolution> };
  canonicalRepairDispatcher: {
    materialize(input: CanonicalRepairDispatchInput): Promise<CanonicalRepairDispatchOutcome>;
  };
  interventionReceiptOwner: { resolve(ref: OwnerTruthRefV1): Promise<EvalRepairInterventionReceipt | null> };
  freshOutcomeOwner: { resolve(ref: OwnerTruthRefV1): Promise<EvalRepairFreshOutcomeReceipt | null> };
  decisionOwner: EvalRepairOwnerRuntimeBindings['decisionOwner'];
}

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
}

function exactCycleRef(cycle: number): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F311',
    ownerStateRef: `evolution-cycle:${REQUEST_REVIEW_EVOLUTION_PROGRAM_ID}:${cycle}`,
  });
}

function originMessageId(record: InvocationRecord): string | undefined {
  return record.originTriggerMessageId ?? record.a2aTriggerMessageId;
}

function strictRecordMatches(
  record: InvocationRecord | null,
  principal: EvalRepairAuthenticatedPrincipal,
  ownerUserId: string,
): record is InvocationRecord {
  return Boolean(
    record &&
      record.ownerAuthProvenance === 'strict' &&
      record.invocationId === principal.invocationId &&
      record.userId === ownerUserId &&
      record.userId === principal.userId &&
      record.catId === principal.catId &&
      record.threadId === principal.threadId &&
      originMessageId(record) === principal.originMessageId,
  );
}

interface OwnerTruthOptions {
  programReader: RequestReviewEvalRepairOwnerProviderOptions['programReader'];
  versionReader: RequestReviewEvalRepairOwnerProviderOptions['versionReader'];
}

async function readExactProgram(options: OwnerTruthOptions): Promise<RequestReviewProgramSnapshot | null> {
  try {
    const projection = await options.programReader.get(REQUEST_REVIEW_EVOLUTION_PROGRAM_ID);
    if (
      projection.program.programId !== REQUEST_REVIEW_EVOLUTION_PROGRAM_ID ||
      !sameRef(projection.program.objectRef, TARGET_REF) ||
      !Number.isSafeInteger(projection.program.cycle) ||
      projection.program.cycle < 1
    ) {
      return null;
    }
    return projection;
  } catch {
    return null;
  }
}

function lineageMatches(lineage: EvalRepairOwnerLineage, program: RequestReviewProgramSnapshot): boolean {
  return (
    sameRef(lineage.programRef, PROGRAM_REF) &&
    sameRef(lineage.cycleRef, exactCycleRef(program.program.cycle)) &&
    sameRef(lineage.interventionRef, TARGET_REF)
  );
}

function ownerUserId(ref: OwnerTruthRefV1 | undefined): string | undefined {
  return ref?.ownerFeatureId === 'F311' && ref.ownerStateRef.startsWith('user:')
    ? ref.ownerStateRef.slice('user:'.length) || undefined
    : undefined;
}

function blockerRef(kind: string): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
    ownerStateRef: `owner-blocker:${kind}`,
  });
}

export async function resolveRequestReviewCurrentOwnerSnapshot(options: OwnerTruthOptions) {
  const program = await readExactProgram(options);
  if (!program)
    return { status: 'blocked' as const, reason: 'owner_unresolved' as const, blockerRef: blockerRef('program') };
  let versionRef: ExactAssetVersionRefV1;
  try {
    versionRef = await options.versionReader.currentVersionRef();
  } catch {
    return {
      status: 'blocked' as const,
      reason: 'owner_authorization_unreadable' as const,
      blockerRef: blockerRef('version-unreadable'),
    };
  }
  if (!isRequestReviewAssetVersionRef(versionRef)) {
    return { status: 'blocked' as const, reason: 'owner_unresolved' as const, blockerRef: blockerRef('asset') };
  }
  return {
    status: 'resolved' as const,
    ownerRef: ownerTruthRefV1Schema.parse({
      ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
      ownerStateRef: 'owner:request-review-v1',
    }),
    ownerAuthorizationRef: ownerTruthRefV1Schema.parse({
      ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
      ownerStateRef: `authorization:request-review-${program.program.cycle}-${versionRef.version}`,
    }),
    targetVersionRef: versionRef,
    dispatchRef: ownerTruthRefV1Schema.parse({
      ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
      ownerStateRef: `dispatch:request-review-${program.program.cycle}-${versionRef.version}`,
    }),
  };
}

function createBindings(options: RequestReviewEvalRepairOwnerProviderOptions): EvalRepairOwnerRuntimeBindings {
  const requestAuthorityVerifier: EvalRepairOwnerRuntimeBindings['requestAuthorityVerifier'] = {
    async verify(principal, lineage) {
      if (!lineage) return { status: 'blocked', reason: 'request_origin_unverified' };
      const program = await readExactProgram(options);
      if (!program || !lineageMatches(lineage, program)) {
        return { status: 'blocked', reason: 'request_origin_unverified' };
      }
      const record = await options.invocationRegistry.peekRecord(principal.invocationId);
      return strictRecordMatches(record, principal, options.ownerUserId)
        ? { status: 'verified', principal }
        : { status: 'blocked', reason: 'request_origin_unverified' };
    },
  };

  return {
    async resolveOwnerChangeContract(input) {
      if (
        input.featureId !== REQUEST_REVIEW_OWNER_FEATURE_ID ||
        input.componentId !== REQUEST_REVIEW_TARGET_STATE_REF
      ) {
        return { status: 'blocked', reason: 'owner_unresolved', blockerRef: blockerRef('scope') };
      }
      const current = await resolveRequestReviewCurrentOwnerSnapshot(options);
      if (current.status === 'blocked') return current;
      if (current.targetVersionRef.version !== input.expectedTargetVersion) {
        return {
          status: 'blocked',
          reason: 'target_version_mismatch',
          blockerRef: blockerRef(`target-${current.targetVersionRef.version}`),
        };
      }
      return current;
    },
    canonicalRepairDispatcher: options.canonicalRepairDispatcher,
    interventionReceiptOwner: options.interventionReceiptOwner,
    freshOutcomeOwner: options.freshOutcomeOwner,
    requestAuthorityVerifier,
    lineageResolver: {
      async resolve(lineage) {
        const program = await readExactProgram(options);
        if (!program || !lineageMatches(lineage, program)) return { status: 'blocked', reason: 'lineage_mismatch' };
        try {
          return await options.lineageBindingResolver.resolve(lineage);
        } catch {
          return { status: 'blocked', reason: 'lineage_missing' };
        }
      },
    },
    valueDecisionAuthorityVerifier: {
      async verify(authority, subject) {
        const program = await readExactProgram(options);
        if (!program || !sameRef(subject.programRef, PROGRAM_REF)) {
          return { status: 'blocked', reason: 'value_owner_unverified' };
        }
        const expectedUserId = ownerUserId(program.program.valueOwnerRef);
        if (!expectedUserId || expectedUserId !== options.ownerUserId || typeof authority !== 'object' || !authority) {
          return { status: 'blocked', reason: 'value_owner_unverified' };
        }
        const candidate = authority as Record<string, unknown>;
        if (candidate.kind === 'owner_session' && candidate.userId === expectedUserId) {
          return {
            status: 'verified',
            authorityRef: ownerTruthRefV1Schema.parse({
              ownerFeatureId: 'F311',
              ownerStateRef: `value-owner-session:${expectedUserId}`,
            }),
          };
        }
        if (candidate.kind === 'owner_source') {
          const principal = candidate as unknown as EvalRepairAuthenticatedPrincipal;
          const verified = await requestAuthorityVerifier.verify(principal, {
            programRef: subject.programRef,
            cycleRef: subject.cycleRef,
            interventionRef: TARGET_REF,
          });
          if (verified.status === 'verified') {
            return {
              status: 'verified',
              authorityRef: ownerTruthRefV1Schema.parse({
                ownerFeatureId: 'F311',
                ownerStateRef: `value-owner-source:${principal.invocationId}:${principal.originMessageId}`,
              }),
            };
          }
        }
        return { status: 'blocked', reason: 'value_owner_unverified' };
      },
    },
    decisionOwner: options.decisionOwner,
  };
}

export function createRequestReviewEvalRepairOwnerBindingProvider(
  options: RequestReviewEvalRepairOwnerProviderOptions,
): EvalRepairOwnerRuntimeBindingProvider {
  return {
    route: {
      schemaVersion: 1,
      providerId: 'request-review-eval-repair-owner-v1',
      programRefs: [PROGRAM_REF],
      repairTargetRefs: [
        {
          ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
          ownerStateRef: REQUEST_REVIEW_TARGET_STATE_REF,
          match: 'exact',
        },
      ],
      assetVersionRefs: [
        {
          ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
          ownerStateRef: `skill:${REQUEST_REVIEW_ASSET_ID}`,
          match: 'exact',
        },
      ],
      interventionReceiptRefs: [
        {
          ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
          ownerStateRef: 'intervention:request-review-',
          match: 'prefix',
        },
      ],
      freshOutcomeReceiptRefs: [
        {
          ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
          ownerStateRef: 'fresh-outcome:request-review-',
          match: 'prefix',
        },
      ],
    },
    async resolve() {
      return createBindings(options);
    },
  };
}
