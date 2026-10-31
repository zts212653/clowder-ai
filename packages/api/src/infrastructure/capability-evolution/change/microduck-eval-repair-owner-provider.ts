import { type OwnerTruthRefV1, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type {
  CanonicalRepairDispatchInput,
  CanonicalRepairDispatchOutcome,
  EvalRepairAuthenticatedPrincipal,
  EvalRepairOwnerLineage,
  EvalRepairOwnerResolution,
} from '../../harness-eval/eval-repair-approval-contracts.js';
import type {
  EvalRepairFreshOutcomeReceipt,
  EvalRepairInterventionReceipt,
} from '../../harness-eval/eval-repair-outcome-contracts.js';
import type {
  EvalRepairOwnerRuntimeBindingProvider,
  EvalRepairOwnerRuntimeBindings,
} from '../../harness-eval/eval-repair-owner-runtime.js';
import type { MicroduckOwnerAdapter } from '../adapters/microduck-owner-adapter.js';
import type { MicroduckObservation } from '../adapters/microduck-owner-contract.js';

export const MICRODUCK_PROGRAM_ID = 'evolution-program:5073988075254b6eac9a0de0e3a27125';
const TARGET_STATE_REF = 'simulator:walking';
const OWNER_FEATURE_ID = 'microduck-owner';

const PROGRAM_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: 'F311',
  ownerStateRef: MICRODUCK_PROGRAM_ID,
});
const AUTHORIZATION_BLOCKER_REF = ownerTruthRefV1Schema.parse({
  ownerFeatureId: OWNER_FEATURE_ID,
  ownerStateRef: 'permission:simulator:walking:missing',
});

interface MicroduckProgramSnapshot {
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

export interface MicroduckEvalRepairOwnerProviderOptions {
  ownerUserId: string;
  programReader: { get(programId: string): Promise<MicroduckProgramSnapshot> };
  invocationRegistry: { peekRecord(invocationId: string): Promise<InvocationRecord | null> };
  adapter: Pick<MicroduckOwnerAdapter, 'observe'>;
  /** Exact Program/cycle/object → F266 case carrier. No target-only scan is permitted. */
  lineageBindingResolver?: { resolve(lineage: EvalRepairOwnerLineage): Promise<LineageResolution> };
  /** Canonical owner permission snapshot; the provider supplies the observed target for comparison. */
  ownerChangeContractResolver?: {
    resolve(input: {
      caseId: string;
      verdictId: string;
      programRef: OwnerTruthRefV1;
      cycleRef: OwnerTruthRefV1;
      objectRef: OwnerTruthRefV1;
      observedTargetVersionRef: MicroduckObservation['targetVersionRef'];
    }): Promise<EvalRepairOwnerResolution>;
  };
  canonicalRepairDispatcher?: {
    materialize(input: CanonicalRepairDispatchInput): Promise<CanonicalRepairDispatchOutcome>;
  };
  interventionReceiptOwner?: {
    resolve(receiptRef: OwnerTruthRefV1): Promise<EvalRepairInterventionReceipt | null>;
  };
  freshOutcomeOwner?: {
    resolve(receiptRef: OwnerTruthRefV1): Promise<EvalRepairFreshOutcomeReceipt | null>;
  };
  decisionOwner?: EvalRepairOwnerRuntimeBindings['decisionOwner'];
}

function sameRef(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  return refIdentity(left) === refIdentity(right);
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

function exactCycleRef(cycle: number): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F311',
    ownerStateRef: `evolution-cycle:${MICRODUCK_PROGRAM_ID}:${cycle}`,
  });
}

function exactObjectRef(value: OwnerTruthRefV1): boolean {
  return (
    value.ownerFeatureId === OWNER_FEATURE_ID &&
    value.ownerStateRef === TARGET_STATE_REF &&
    typeof value.version === 'string' &&
    /^[a-f0-9]{40}$/u.test(value.version)
  );
}

async function readExactProgram(
  options: MicroduckEvalRepairOwnerProviderOptions,
): Promise<MicroduckProgramSnapshot | undefined> {
  try {
    const projection = await options.programReader.get(MICRODUCK_PROGRAM_ID);
    if (
      projection.program.programId !== MICRODUCK_PROGRAM_ID ||
      !exactObjectRef(projection.program.objectRef) ||
      !Number.isSafeInteger(projection.program.cycle) ||
      projection.program.cycle < 1
    ) {
      return undefined;
    }
    return projection;
  } catch {
    return undefined;
  }
}

function lineageMatchesProgram(lineage: EvalRepairOwnerLineage, projection: MicroduckProgramSnapshot): boolean {
  return (
    sameRef(lineage.programRef, PROGRAM_REF) &&
    sameRef(lineage.cycleRef, exactCycleRef(projection.program.cycle)) &&
    sameRef(lineage.interventionRef, projection.program.objectRef)
  );
}

function valueOwnerUserId(ref: OwnerTruthRefV1 | undefined): string | undefined {
  return ref?.ownerFeatureId === 'F311' && ref.ownerStateRef.startsWith('user:')
    ? ref.ownerStateRef.slice('user:'.length) || undefined
    : undefined;
}

function validatedOwnerResolution(
  result: EvalRepairOwnerResolution,
  observedTargetVersionRef: MicroduckObservation['targetVersionRef'],
): EvalRepairOwnerResolution {
  if (result.status === 'blocked') return result;
  if (
    result.ownerRef.ownerFeatureId !== OWNER_FEATURE_ID ||
    result.ownerAuthorizationRef.ownerFeatureId !== OWNER_FEATURE_ID ||
    result.dispatchRef.ownerFeatureId !== OWNER_FEATURE_ID ||
    !sameRef(result.targetVersionRef, observedTargetVersionRef)
  ) {
    return {
      status: 'blocked',
      reason: 'owner_authorization_target_mismatch',
      blockerRef: AUTHORIZATION_BLOCKER_REF,
    };
  }
  return result;
}

function createBindings(options: MicroduckEvalRepairOwnerProviderOptions): EvalRepairOwnerRuntimeBindings {
  const requestAuthorityVerifier: EvalRepairOwnerRuntimeBindings['requestAuthorityVerifier'] = {
    async verify(principal, lineage) {
      if (!lineage) return { status: 'blocked', reason: 'request_origin_unverified' };
      const projection = await readExactProgram(options);
      if (!projection || !lineageMatchesProgram(lineage, projection)) {
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
      if (input.featureId !== OWNER_FEATURE_ID || input.componentId !== TARGET_STATE_REF) {
        return { status: 'blocked', reason: 'owner_unresolved', blockerRef: AUTHORIZATION_BLOCKER_REF };
      }
      const projection = await readExactProgram(options);
      if (!projection) {
        return { status: 'blocked', reason: 'owner_unresolved', blockerRef: AUTHORIZATION_BLOCKER_REF };
      }
      const scope = {
        programRef: PROGRAM_REF,
        cycleRef: exactCycleRef(projection.program.cycle),
        objectRef: projection.program.objectRef,
      };
      const observation = await options.adapter.observe(scope);
      if (observation.status === 'blocked') {
        return {
          status: 'blocked',
          reason: observation.code === 'target_drift' ? 'target_version_mismatch' : 'owner_unresolved',
          blockerRef: observation.blockerRef ?? AUTHORIZATION_BLOCKER_REF,
        };
      }
      if (
        observation.targetVersionRef.ownerFeatureId !== OWNER_FEATURE_ID ||
        observation.targetVersionRef.ownerStateRef !== TARGET_STATE_REF ||
        observation.targetVersionRef.version !== input.expectedTargetVersion
      ) {
        return {
          status: 'blocked',
          reason: 'target_version_mismatch',
          blockerRef: AUTHORIZATION_BLOCKER_REF,
        };
      }
      if (!options.ownerChangeContractResolver) {
        return {
          status: 'blocked',
          reason: 'owner_authorization_missing',
          blockerRef: AUTHORIZATION_BLOCKER_REF,
        };
      }
      try {
        return validatedOwnerResolution(
          await options.ownerChangeContractResolver.resolve({
            caseId: input.caseId,
            verdictId: input.verdictId,
            ...scope,
            observedTargetVersionRef: observation.targetVersionRef,
          }),
          observation.targetVersionRef,
        );
      } catch {
        return {
          status: 'blocked',
          reason: 'owner_authorization_unreadable',
          blockerRef: AUTHORIZATION_BLOCKER_REF,
        };
      }
    },
    canonicalRepairDispatcher: {
      async materialize(input) {
        if (!options.canonicalRepairDispatcher) {
          return {
            status: 'blocked',
            reason: 'owner_authorization_missing',
            blockerRef: AUTHORIZATION_BLOCKER_REF,
          };
        }
        return options.canonicalRepairDispatcher.materialize(input);
      },
    },
    interventionReceiptOwner: options.interventionReceiptOwner ?? {
      async resolve() {
        return null;
      },
    },
    freshOutcomeOwner: options.freshOutcomeOwner ?? {
      async resolve() {
        return null;
      },
    },
    requestAuthorityVerifier,
    lineageResolver: {
      async resolve(lineage) {
        const projection = await readExactProgram(options);
        if (!projection || !lineageMatchesProgram(lineage, projection)) {
          return { status: 'blocked', reason: 'lineage_mismatch' };
        }
        if (!options.lineageBindingResolver) return { status: 'blocked', reason: 'lineage_missing' };
        try {
          const result = await options.lineageBindingResolver.resolve(lineage);
          if (result.status === 'blocked') return result;
          return /^case-action:f266:[^\s]+$/u.test(result.caseActionRef)
            ? result
            : { status: 'blocked', reason: 'lineage_missing' };
        } catch {
          return { status: 'blocked', reason: 'lineage_missing' };
        }
      },
    },
    valueDecisionAuthorityVerifier: {
      async verify(authority, subject) {
        const projection = await readExactProgram(options);
        if (!projection || !sameRef(subject.programRef, PROGRAM_REF)) {
          return { status: 'blocked', reason: 'value_owner_unverified' };
        }
        const userId = valueOwnerUserId(projection.program.valueOwnerRef);
        if (!userId || userId !== options.ownerUserId || typeof authority !== 'object' || authority === null) {
          return { status: 'blocked', reason: 'value_owner_unverified' };
        }
        const candidate = authority as Record<string, unknown>;
        if (candidate.kind === 'owner_session' && candidate.userId === userId) {
          return {
            status: 'verified',
            authorityRef: ownerTruthRefV1Schema.parse({
              ownerFeatureId: 'F311',
              ownerStateRef: `value-owner-session:${userId}`,
            }),
          };
        }
        if (candidate.kind === 'owner_source') {
          const principal = candidate as unknown as EvalRepairAuthenticatedPrincipal;
          const record = await options.invocationRegistry.peekRecord(principal.invocationId);
          if (strictRecordMatches(record, principal, options.ownerUserId)) {
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
    decisionOwner: options.decisionOwner ?? {
      async execute() {
        return { status: 'blocked', reason: 'owner_authorization_missing' };
      },
    },
  };
}

export function createMicroduckEvalRepairOwnerBindingProvider(
  options: MicroduckEvalRepairOwnerProviderOptions,
): EvalRepairOwnerRuntimeBindingProvider {
  return {
    route: {
      schemaVersion: 1,
      providerId: 'microduck-eval-repair-owner-v1',
      programRefs: [PROGRAM_REF],
      repairTargetRefs: [{ ownerFeatureId: OWNER_FEATURE_ID, ownerStateRef: TARGET_STATE_REF, match: 'exact' }],
      assetVersionRefs: [{ ownerFeatureId: OWNER_FEATURE_ID, ownerStateRef: TARGET_STATE_REF, match: 'exact' }],
      interventionReceiptRefs: [{ ownerFeatureId: OWNER_FEATURE_ID, ownerStateRef: 'deploy:sha256:', match: 'prefix' }],
      freshOutcomeReceiptRefs: [
        { ownerFeatureId: OWNER_FEATURE_ID, ownerStateRef: 'fresh-outcome:sha256:', match: 'prefix' },
      ],
    },
    async resolve() {
      return createBindings(options);
    },
  };
}
