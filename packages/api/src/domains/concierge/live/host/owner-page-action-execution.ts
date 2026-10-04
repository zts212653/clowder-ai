import { randomUUID } from 'node:crypto';
import { createCdpPageActionPort } from '../../action/CdpPageActionPort.js';
import { pageActionGrantSha256 } from '../../action/LivePageAction.js';
import type { PageActionResult } from '../../action/PageActionLoop.js';
import { whileNotAborted } from './live-controlled-context.js';
import type { TrustedPageActionApproval } from './live-page-action-authority-contract.js';
import type {
  OwnerPageAction,
  OwnerPageActionOutcome,
  OwnerPageActionProfile,
  OwnerPageCallEntry,
  OwnerPagePreview,
} from './owner-page-action-contract.js';

const ACTION_MS = 12_000;
const INSPECTION_MS = 5_000;

function issueApproval(
  entry: OwnerPageCallEntry,
  preview: OwnerPagePreview,
  action: OwnerPageAction,
): TrustedPageActionApproval {
  const approval: TrustedPageActionApproval = {
    approvalId: randomUUID(),
    permissionScope: preview.plan.profileId,
    expiresAtMs: preview.expiresAtMs,
    origin: preview.plan.origin,
    url: preview.plan.url,
    targetId: action.targetId,
    operation: action.operation,
    value: action.value,
    expectedReadback: action.expectedReadback,
  };
  entry.ledger.issue({
    approvalId: approval.approvalId,
    scope: preview.scope,
    requestSourceRef: `${preview.scope.threadId}#${preview.requestMessageId}`,
    requestRevision: preview.requestRevision,
    actionSha256: pageActionGrantSha256({
      origin: approval.origin,
      url: approval.url,
      requestRevision: preview.requestRevision,
      actions: [{ ...action }],
    }),
    permissionScope: approval.permissionScope,
    expiresAtMs: approval.expiresAtMs,
  });
  return approval;
}

export async function executeApprovedPageAction(input: {
  entry: OwnerPageCallEntry;
  preview: OwnerPagePreview;
  profile: OwnerPageActionProfile;
  action: OwnerPageAction;
  port: OwnerPagePreview['port'];
  step: 'forward' | 'rollback';
  onPortTransferred?(): void;
}): Promise<PageActionResult> {
  const { entry, preview, profile, action, port, step } = input;
  const approval = issueApproval(entry, preview, action);
  if (step === 'forward') preview.approvalId = approval.approvalId;
  else preview.rollbackApprovalId = approval.approvalId;
  const selector = profile.selector(action);
  const timeout = setTimeout(() => entry.call.boundaryContexts.revokePageAction(approval.approvalId), ACTION_MS);
  try {
    input.onPortTransferred?.();
    return await entry.call.boundaryContexts.runPageAction({
      requestMessageId: preview.requestMessageId,
      approval,
      port,
      selector,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function restoreAppliedPageAction(
  entry: OwnerPageCallEntry,
  preview: OwnerPagePreview,
  profile: OwnerPageActionProfile,
  forward: PageActionResult,
): Promise<PageActionResult> {
  const created = createCdpPageActionPort(preview.handle.page, profile.spec);
  if (!created.close) throw new Error('Rollback actor cannot be closed');
  const port = created as OwnerPagePreview['port'];
  try {
    const signal = AbortSignal.any([preview.signal, AbortSignal.timeout(INSPECTION_MS)]);
    const snapshot = await whileNotAborted(signal, port.inspect());
    const action = profile.rollback(preview.plan, forward, snapshot);
    const target = snapshot.candidates.find((candidate) => candidate.id === action.targetId);
    if (
      snapshot.url !== preview.plan.url ||
      snapshot.origin !== preview.plan.origin ||
      snapshot.readback !== forward.after ||
      action.targetId !== preview.plan.action.targetId ||
      action.operation !== preview.plan.action.operation ||
      action.value !== preview.plan.consent.restoreValue ||
      action.expectedReadback !== preview.plan.beforeReadback ||
      target?.operation !== action.operation ||
      target?.label !== preview.plan.consent.field ||
      target?.fingerprint !== action.fingerprint
    )
      throw new Error('Named page restoration changed');
    return await executeApprovedPageAction({ entry, preview, profile, action, port, step: 'rollback' });
  } finally {
    await port.close().catch(() => {});
  }
}

export function forwardOutcome(forward: PageActionResult): OwnerPageActionOutcome {
  const status =
    forward.status === 'no_effect'
      ? 'no_effect'
      : forward.status === 'cancelled'
        ? 'cancelled'
        : forward.status === 'denied'
          ? 'denied'
          : 'unknown';
  return { status, forward };
}
