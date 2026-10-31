import type { ApprovalIngress } from '../../domains/approval-hub/ApprovalIngress.js';
import type { ApprovalEpochAuthorization } from '../../domains/approval-hub/ApprovalLifecycleEpochAuthority.js';
import type { IApprovalAdapter } from '../../domains/approval-hub/ports/IApprovalAdapter.js';
import { EvalRepairApprovalService } from './eval-repair-approval.js';
import type {
  CanonicalRepairDispatchInput,
  CanonicalRepairDispatchOutcome,
  EvalRepairCaseAction,
  EvalRepairOwnerResolution,
} from './eval-repair-approval-contracts.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';

export const F313_APPROVAL_CUTOVER_VERSION = 1 as const;

export interface EvalRepairCutoverOptions {
  lifecycleVersion: number;
  loaderVersion: number;
  routeVersion: number;
  materializerVersion: number;
  eventLog?: IReevalClosureEventLog;
  approvalIngress?: Pick<ApprovalIngress, 'publish'>;
  approvalAdapter?: IApprovalAdapter;
  epochAuthority?: {
    authorize(
      producerId: 'F266',
      writer: 'v1',
      operation: 'proposal_ingress' | 'decision' | 'materialization',
    ): Promise<ApprovalEpochAuthorization>;
  };
  caseActionResolver?: (caseActionRef: string) => Promise<EvalRepairCaseAction | null>;
  ownerResolver?: (input: {
    caseId: string;
    verdictId: string;
    featureId: string;
    componentId?: string;
    expectedTargetVersion: string;
  }) => Promise<EvalRepairOwnerResolution>;
  repairDispatcher?: {
    materialize(input: CanonicalRepairDispatchInput): Promise<CanonicalRepairDispatchOutcome>;
  };
  now?: () => string;
}

const CLOSED_EFFECTS = Object.freeze({
  openCase: false,
  approvalProposal: false,
  approvalCard: false,
  task: false,
  f167Lease: false,
});

export type EvalRepairCutover =
  | { status: 'blocked'; missing: string[]; effects: typeof CLOSED_EFFECTS }
  | {
      status: 'active';
      service: EvalRepairApprovalService;
      rootActivation: { lifecycleVersion: 1 };
      epochRef: string;
    };

type CompleteEvalRepairCutoverOptions = EvalRepairCutoverOptions &
  Required<
    Pick<
      EvalRepairCutoverOptions,
      | 'eventLog'
      | 'approvalIngress'
      | 'approvalAdapter'
      | 'epochAuthority'
      | 'caseActionResolver'
      | 'ownerResolver'
      | 'repairDispatcher'
    >
  >;

export async function createEvalRepairCutover(options: EvalRepairCutoverOptions): Promise<EvalRepairCutover> {
  const missing = collectMissingCutoverBindings(options);
  if (missing.length > 0) return { status: 'blocked', missing, effects: CLOSED_EFFECTS };
  if (!hasCompleteCutoverBindings(options)) throw new Error('complete F313 cutover bindings failed to narrow');

  const { epochAuthority } = options;
  let epoch: ApprovalEpochAuthorization | undefined;
  for (const operation of ['proposal_ingress', 'decision', 'materialization'] as const) {
    const permit = await epochAuthority.authorize('F266', 'v1', operation);
    if (!permit.allowed || permit.record.phase !== 'v1_active' || !permit.record.cutoverReceiptRef) {
      return { status: 'blocked', missing: [`epoch:${operation}:v1_active`], effects: CLOSED_EFFECTS };
    }
    if (
      epoch?.allowed &&
      (permit.record.epoch !== epoch.record.epoch || permit.record.revision !== epoch.record.revision)
    ) {
      return { status: 'blocked', missing: ['epoch:snapshot_drift'], effects: CLOSED_EFFECTS };
    }
    epoch = permit;
  }
  if (!epoch?.allowed) return { status: 'blocked', missing: ['epoch:v1_active'], effects: CLOSED_EFFECTS };
  const service = new EvalRepairApprovalService({
    eventLog: options.eventLog,
    epochAuthority,
    resolveCaseAction: options.caseActionResolver,
    resolveOwnerChangeContract: options.ownerResolver,
    approvalIngress: options.approvalIngress,
    canonicalRepairDispatcher: options.repairDispatcher,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    status: 'active',
    service,
    rootActivation: { lifecycleVersion: 1 },
    epochRef: `approval:lifecycle-epoch:F266:${epoch.record.epoch}:${epoch.record.revision}`,
  };
}

function collectMissingCutoverBindings(options: EvalRepairCutoverOptions): string[] {
  const missing: string[] = [];
  if (options.lifecycleVersion !== 1) missing.push('lifecycleVersion@1');
  if (options.loaderVersion !== 1) missing.push('loaderVersion@1');
  if (options.routeVersion !== 1) missing.push('routeVersion@1');
  if (options.materializerVersion !== 1) missing.push('materializerVersion@1');
  for (const key of [
    'eventLog',
    'approvalIngress',
    'approvalAdapter',
    'epochAuthority',
    'caseActionResolver',
    'ownerResolver',
    'repairDispatcher',
  ] as const) {
    if (!options[key]) missing.push(key);
  }
  if (options.approvalAdapter && options.approvalAdapter.featureId !== 'F266') missing.push('approvalAdapter:F266');
  return missing;
}

function hasCompleteCutoverBindings(options: EvalRepairCutoverOptions): options is CompleteEvalRepairCutoverOptions {
  return Boolean(
    options.eventLog &&
      options.approvalIngress &&
      options.approvalAdapter &&
      options.epochAuthority &&
      options.caseActionResolver &&
      options.ownerResolver &&
      options.repairDispatcher,
  );
}
