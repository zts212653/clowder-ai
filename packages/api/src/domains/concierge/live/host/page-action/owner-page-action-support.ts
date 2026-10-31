import type { PageSnapshot } from '../../../action/PageActionLoop.js';
import { whileNotAborted } from '../live-controlled-context.js';
import type {
  OwnerPageActionConsent,
  OwnerPageActionDeps,
  OwnerPageActionOutcome,
  OwnerPageActionPlan,
  OwnerPageActionProfile,
  OwnerPageActionView,
  OwnerPageCallEntry,
  OwnerPagePreview,
} from '../owner-page-action-contract.js';
import { invocationPageOutcome, invocationSelectionReceipt } from './owner-page-action-invocation-view.js';

export function armOwnerPagePreview(preview: OwnerPagePreview, onAbort: () => void): void {
  const timer = setTimeout(onAbort, Math.max(1, preview.expiresAtMs - Date.now()));
  timer.unref();
  preview.disarmLifetime = () => {
    clearTimeout(timer);
    preview.signal.removeEventListener('abort', onAbort);
  };
  preview.signal.addEventListener('abort', onAbort, { once: true });
  if (preview.signal.aborted) onAbort();
}

export function validPlan(profile: OwnerPageActionProfile, snapshot: PageSnapshot, plan: OwnerPageActionPlan): boolean {
  const target = snapshot.candidates.find((candidate) => candidate.id === plan.action.targetId);
  const configured = profile.spec.targets.find((candidate) => candidate.id === plan.action.targetId);
  return (
    snapshot.url === profile.url &&
    plan.profileId === profile.profileId &&
    plan.url === profile.url &&
    plan.origin === snapshot.origin &&
    plan.consent.pageUrl === profile.url &&
    plan.consent.field === target?.label &&
    plan.consent.value === plan.action.value &&
    plan.beforeReadback === snapshot.readback &&
    configured?.operation === plan.action.operation &&
    target?.operation === plan.action.operation &&
    target?.fingerprint === plan.action.fingerprint
  );
}

export function canInspect(entry: OwnerPageCallEntry | undefined, signal: AbortSignal | null): boolean {
  return Boolean(entry && signal && !entry.inspecting && (!entry.preview || entry.preview.state === 'settled'));
}

export function consent(
  preview: OwnerPagePreview,
  profile: NonNullable<OwnerPageActionDeps['profile']>,
): OwnerPageActionConsent {
  const target = profile.spec.targets.find((item) => item.id === preview.plan.action.targetId);
  if (!target) throw new Error('Named page target unavailable');
  return {
    previewId: preview.id,
    pageUrl: preview.plan.consent.pageUrl,
    field: preview.plan.consent.field,
    fieldSelector: target.selector,
    readbackSelector: profile.spec.readback.selector,
    operation: preview.plan.action.operation,
    value: preview.plan.consent.value,
    expectedReadback: preview.plan.action.expectedReadback,
    restoreValue: preview.plan.consent.restoreValue,
    ...(preview.plan.selection ? { selection: preview.plan.selection } : {}),
    expiresAtMs: preview.expiresAtMs,
    permissionScope: preview.plan.profileId,
  };
}

export async function closeResources(
  handle: OwnerPagePreview['handle'],
  port?: OwnerPagePreview['port'],
): Promise<boolean> {
  // Detach the actor before disconnecting an attached owner browser. Always try both cleanups.
  const completed = (async () => {
    const actor = await Promise.allSettled(port ? [port.close()] : []);
    const handleResult = await Promise.allSettled([handle.close()]);
    return [...actor, ...handleResult];
  })();
  const deadline = AbortSignal.timeout(1_000);
  try {
    const results = await whileNotAborted(deadline, completed);
    return results.every((result) => result.status === 'fulfilled');
  } catch {
    return false;
  }
}

export function closePreview(preview: OwnerPagePreview, closeActor = true): Promise<boolean> {
  return closeResources(preview.handle, closeActor ? preview.port : undefined);
}

/** A completed observation survives a new request, but never supplies an executable preview. */
export function rememberPageOutcome(
  entry: OwnerPageCallEntry,
  preview: OwnerPagePreview,
  outcome: OwnerPageActionOutcome,
): void {
  preview.outcome = outcome;
  const previous = entry.lastReceipt;
  // A late persistence response must not replace a newer completed action's receipt.
  if (entry.preview !== preview && previous && previous.previewId !== preview.id) return;
  entry.lastReceipt = {
    previewId: preview.id,
    requestMessageId: preview.requestMessageId,
    observedAtMs: previous?.previewId === preview.id ? previous.observedAtMs : Date.now(),
    outcome:
      preview.plan.selection && !outcome.receiptPersistence
        ? { ...outcome, receiptPersistence: 'unconfirmed' }
        : outcome,
  };
}

export function pageResultView(
  entry: OwnerPageCallEntry,
): Pick<
  Extract<OwnerPageActionView, { kind: 'available' }>,
  'result' | 'resultRequestMessageId' | 'resultObservedAtMs'
> {
  const receipt = entry.lastReceipt;
  return receipt
    ? {
        result: receipt.outcome,
        resultRequestMessageId: receipt.requestMessageId,
        resultObservedAtMs: receipt.observedAtMs,
      }
    : {};
}

export async function persistPageOutcome(
  deps: OwnerPageActionDeps,
  preview: OwnerPagePreview,
  outcome: OwnerPageActionOutcome,
  onStored?: (messageId: string) => void,
): Promise<OwnerPageActionOutcome> {
  if (!deps.recordResult) return outcome;
  try {
    const messageId = await deps.recordResult({
      scope: preview.scope,
      requestMessageId: preview.requestMessageId,
      body: JSON.stringify({
        kind: 'host_page_action_receipt',
        callId: preview.scope.callId,
        generation: preview.scope.generation,
        ...(preview.profile?.spec.currentControls
          ? {
              ...(preview.plan.selection ? { selection: invocationSelectionReceipt(preview.plan.selection) } : {}),
              outcome: invocationPageOutcome(outcome),
            }
          : { previewId: preview.id, selection: preview.plan.selection, outcome }),
      }),
      receiptId: preview.id,
    });
    if (typeof messageId === 'string') onStored?.(messageId);
    return { ...outcome, receiptPersistence: 'stored' };
  } catch {
    return { ...outcome, receiptPersistence: 'unconfirmed' };
  }
}

export async function settlePageOutcome(
  deps: OwnerPageActionDeps,
  entry: OwnerPageCallEntry,
  preview: OwnerPagePreview,
  outcome: OwnerPageActionOutcome,
): Promise<OwnerPageActionOutcome> {
  let messageId: string | undefined;
  const stored = await persistPageOutcome(deps, preview, outcome, (id) => {
    messageId = id;
  });
  rememberPageOutcome(entry, preview, stored);
  const receipt = entry.lastReceipt;
  if (
    messageId &&
    preview.plan.selection &&
    receipt?.previewId === preview.id &&
    stored.receiptPersistence === 'stored'
  ) {
    entry.call.boundaryContexts.queuePageResult({
      scope: preview.scope,
      sourceRefs: [`${preview.scope.threadId}#${preview.requestMessageId}`, `${preview.scope.threadId}#${messageId}`],
      text: JSON.stringify({
        kind: 'host_page_action_receipt',
        callId: preview.scope.callId,
        generation: preview.scope.generation,
        receiptMessageId: messageId,
        resultRequestMessageId: receipt.requestMessageId,
        resultObservedAtMs: receipt.observedAtMs,
        result: preview.profile?.spec.currentControls ? invocationPageOutcome(receipt.outcome) : receipt.outcome,
      }),
      isCurrent: () => entry.lastReceipt === receipt && entry.call.acceptsInput() && entry.call.householdToolsEnabled,
    });
  }
  return stored;
}
