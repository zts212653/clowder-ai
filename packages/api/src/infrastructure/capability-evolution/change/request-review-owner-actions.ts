import { createHash } from 'node:crypto';
import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import type {
  CanonicalRepairDispatchInput,
  EvalRepairOwnerResolution,
} from '../../harness-eval/eval-repair-approval-contracts.js';
import type { RequestReviewOwnerActions } from '../adapters/request-review/request-review-owner-adapter.js';
import type { RequestReviewCanonicalRepairDispatcher } from './request-review-canonical-dispatcher.js';
import type { RequestReviewOwnerReceiptService } from './request-review-owner-receipts.js';

interface OwnerActionsOptions {
  resolveCurrentSnapshot(): Promise<EvalRepairOwnerResolution>;
  dispatcher: Pick<RequestReviewCanonicalRepairDispatcher, 'materialize'>;
  versionVerifier: {
    verifyCommitVersion(
      commitSha: string,
      versionRef: ReturnType<typeof exactAssetVersionRefV1Schema.parse>,
    ): Promise<boolean>;
    isKnownVersion(versionRef: ReturnType<typeof exactAssetVersionRefV1Schema.parse>): Promise<boolean>;
  };
  receipts: RequestReviewOwnerReceiptService;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function blocked(code: string) {
  return { status: 'blocked' as const, code };
}

function canonicalDispatch(value: unknown): CanonicalRepairDispatchInput | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.dispatchId !== 'string') return undefined;
  try {
    for (const key of ['caseRef', 'proposalRef', 'approvalRef', 'ownerRef', 'ownerAuthorizationRef', 'dispatchRef']) {
      ownerTruthRefV1Schema.parse(candidate[key]);
    }
    exactAssetVersionRefV1Schema.parse(candidate.targetVersionRef);
    return value as CanonicalRepairDispatchInput;
  } catch {
    return undefined;
  }
}

function verificationRef(commitSha: string, version: string) {
  const digest = createHash('sha256').update(`${commitSha}:${version}`).digest('hex');
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F100',
    ownerStateRef: `verification:request-review-${digest}`,
  });
}

export function createRequestReviewOwnerActions(options: OwnerActionsOptions): RequestReviewOwnerActions {
  return {
    async observe() {
      const current = await options.resolveCurrentSnapshot();
      return current.status === 'blocked'
        ? blocked(current.reason)
        : {
            status: 'observed',
            targetVersionRef: current.targetVersionRef,
            ownerRef: current.ownerRef,
            observationRefs: [current.dispatchRef],
          };
    },
    async permission(raw: never) {
      const input = record(raw);
      if (!input) return blocked('permission_missing');
      const target = exactAssetVersionRefV1Schema.safeParse(input.targetVersionRef);
      const authorization = ownerTruthRefV1Schema.safeParse(input.ownerAuthorizationRef);
      if (!target.success || !authorization.success) return blocked('permission_missing');
      const current = await options.resolveCurrentSnapshot();
      if (current.status === 'blocked') return blocked(current.reason);
      if (refIdentity(target.data) !== refIdentity(current.targetVersionRef)) {
        return blocked('target_drift');
      }
      if (refIdentity(authorization.data) !== refIdentity(current.ownerAuthorizationRef)) {
        return blocked('permission_missing');
      }
      return { status: 'authorized', permissionRef: authorization.data, targetVersionRef: target.data };
    },
    async mutate(raw: never) {
      const input = canonicalDispatch(raw);
      return input ? options.dispatcher.materialize(input) : blocked('owner_authorization_missing');
    },
    async verify(raw: never) {
      const input = record(raw);
      const commitSha = input?.mainCommitSha;
      const candidate = exactAssetVersionRefV1Schema.safeParse(input?.candidateVersionRef);
      if (typeof commitSha !== 'string' || !candidate.success) return blocked('verification_missing');
      if (!(await options.versionVerifier.verifyCommitVersion(commitSha, candidate.data))) {
        return blocked('verification_missing');
      }
      return {
        status: 'verified',
        candidateVersionRef: candidate.data,
        verificationReceiptRef: verificationRef(commitSha, candidate.data.version),
      };
    },
    async writeback(raw: never) {
      const input = record(raw);
      if (input?.type === 'changed') {
        return options.receipts.recordChanged(input as never);
      }
      if (input?.type === 'no_change') {
        return options.receipts.recordNoChange(input as never);
      }
      return blocked('writeback_failed');
    },
    async freshOutcome(raw: never) {
      const input = record(raw);
      if (!input) return blocked('fresh_outcome_missing');
      return options.receipts.recordFreshOutcome(input as never);
    },
    async rollback(raw: never) {
      const input = record(raw);
      if (!input) return blocked('rollback_failed');
      return options.receipts.recordRollback(input as never);
    },
  };
}
