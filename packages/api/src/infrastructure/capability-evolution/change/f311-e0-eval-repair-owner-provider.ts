import { type OwnerTruthRefV1, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { EvalRepairAuthenticatedPrincipal } from '../../harness-eval/eval-repair-approval-contracts.js';
import type {
  EvalRepairOwnerRuntimeBindingProvider,
  EvalRepairOwnerRuntimeBindings,
} from '../../harness-eval/eval-repair-owner-runtime.js';
import {
  type F311E0EvalRepairOwnerBinding,
  loadF311E0EvalRepairOwnerBinding,
} from './f311-e0-eval-repair-owner-binding.js';

const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';

interface F311ProgramSnapshot {
  program: {
    programId: string;
    objectRef: OwnerTruthRefV1;
    cycle: number;
    valueOwnerRef?: OwnerTruthRefV1;
  };
}

export interface F311E0EvalRepairOwnerProviderOptions {
  repoRoot: string;
  ownerUserId: string;
  programReader: { get(programId: string): Promise<F311ProgramSnapshot> };
  invocationRegistry: { peekRecord(invocationId: string): Promise<InvocationRecord | null> };
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

function valueOwnerUserId(binding: F311E0EvalRepairOwnerBinding): string | undefined {
  const prefix = 'user:';
  return binding.valueOwnerRef.ownerFeatureId === 'F311' && binding.valueOwnerRef.ownerStateRef.startsWith(prefix)
    ? binding.valueOwnerRef.ownerStateRef.slice(prefix.length) || undefined
    : undefined;
}

function createBindings(
  binding: F311E0EvalRepairOwnerBinding,
  options: F311E0EvalRepairOwnerProviderOptions,
): EvalRepairOwnerRuntimeBindings {
  const requestAuthorityVerifier: EvalRepairOwnerRuntimeBindings['requestAuthorityVerifier'] = {
    async verify(principal) {
      const record = await options.invocationRegistry.peekRecord(principal.invocationId);
      return strictRecordMatches(record, principal, options.ownerUserId)
        ? { status: 'verified', principal }
        : { status: 'blocked', reason: 'request_origin_unverified' };
    },
  };

  return {
    async resolveOwnerChangeContract(input) {
      if (
        input.featureId !== binding.targetRef.ownerFeatureId ||
        input.componentId !== binding.targetRef.ownerStateRef
      ) {
        return { status: 'blocked', reason: 'owner_unresolved', blockerRef: binding.ownerAuthorization.blockerRef };
      }
      if (input.expectedTargetVersion !== binding.targetVersionRef.version) {
        return {
          status: 'blocked',
          reason: 'target_version_mismatch',
          blockerRef: binding.ownerAuthorization.blockerRef,
        };
      }
      return {
        status: 'blocked',
        reason: 'owner_authorization_missing',
        blockerRef: binding.ownerAuthorization.blockerRef,
      };
    },
    canonicalRepairDispatcher: {
      async materialize() {
        return {
          status: 'blocked',
          reason: 'owner_authorization_missing',
          blockerRef: binding.ownerAuthorization.blockerRef,
        };
      },
    },
    interventionReceiptOwner: {
      async resolve() {
        return null;
      },
    },
    freshOutcomeOwner: {
      async resolve() {
        return null;
      },
    },
    requestAuthorityVerifier,
    lineageResolver: {
      async resolve(lineage) {
        if (!sameRef(lineage.programRef, binding.programRef) || !sameRef(lineage.interventionRef, binding.targetRef)) {
          return { status: 'blocked', reason: 'lineage_mismatch' };
        }
        let program: F311ProgramSnapshot;
        try {
          program = await options.programReader.get(binding.programRef.ownerStateRef);
        } catch {
          return { status: 'blocked', reason: 'lineage_missing' };
        }
        const expectedCycleRef = {
          ownerFeatureId: 'F311',
          ownerStateRef: `evolution-cycle:${PROGRAM_ID}:${program.program.cycle}`,
        };
        if (
          program.program.programId !== PROGRAM_ID ||
          !sameRef(program.program.objectRef, binding.targetRef) ||
          (program.program.valueOwnerRef !== undefined &&
            !sameRef(program.program.valueOwnerRef, binding.valueOwnerRef)) ||
          !sameRef(lineage.cycleRef, expectedCycleRef)
        ) {
          return { status: 'blocked', reason: 'lineage_mismatch' };
        }
        const exact = binding.lineageBindings.find(
          (candidate) =>
            sameRef(candidate.programRef, lineage.programRef) &&
            sameRef(candidate.cycleRef, lineage.cycleRef) &&
            sameRef(candidate.interventionRef, lineage.interventionRef),
        );
        return exact
          ? { status: 'resolved', caseActionRef: exact.caseActionRef }
          : { status: 'blocked', reason: 'lineage_missing' };
      },
    },
    valueDecisionAuthorityVerifier: {
      async verify(authority, subject) {
        if (!sameRef(subject.programRef, binding.programRef)) {
          return { status: 'blocked', reason: 'value_owner_unverified' };
        }
        const userId = valueOwnerUserId(binding);
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
          const verified = await requestAuthorityVerifier.verify(principal);
          if (verified.status === 'verified' && principal.userId === userId) {
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
    decisionOwner: {
      async execute() {
        return { status: 'blocked', reason: 'owner_authorization_missing' };
      },
    },
  };
}

export function createF311E0EvalRepairOwnerBindingProvider(
  options: F311E0EvalRepairOwnerProviderOptions,
): EvalRepairOwnerRuntimeBindingProvider {
  return {
    async resolve() {
      const binding = await loadF311E0EvalRepairOwnerBinding(options.repoRoot);
      return createBindings(binding, options);
    },
  };
}
