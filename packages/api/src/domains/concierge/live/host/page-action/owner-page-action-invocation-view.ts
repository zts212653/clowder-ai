import type { JevSelectionReceipt } from '../../../action/jev/JevPageSelector.js';
import type { PageActionResult, PageChoice } from '../../../action/PageActionLoop.js';
import type {
  OwnerPageActionConsent,
  OwnerPageActionOutcome,
  OwnerPageActionView,
} from '../owner-page-action-contract.js';

function selectionChoice(choice: PageChoice): PageChoice {
  return choice.kind === 'act'
    ? {
        kind: choice.kind,
        targetId: choice.targetId,
        operation: choice.operation,
        ...(choice.value !== undefined ? { value: choice.value } : {}),
      }
    : { kind: choice.kind, reason: choice.reason };
}

export function invocationSelectionReceipt(selection: JevSelectionReceipt): JevSelectionReceipt {
  return {
    requestId: selection.requestId,
    providerRequestId: selection.providerRequestId,
    requestedModel: selection.requestedModel,
    servedModel: selection.servedModel,
    inputSha256: selection.inputSha256,
    candidates: selection.candidates.map(({ id, label, operation }) => ({ id, label, operation })),
    choice: selectionChoice(selection.choice),
    confidence: selection.confidence,
    elapsedMs: selection.elapsedMs,
  };
}

function invocationConsent(preview: OwnerPageActionConsent) {
  return {
    field: preview.field,
    ...(preview.operation !== undefined ? { operation: preview.operation } : {}),
    ...(preview.value !== undefined ? { value: preview.value } : {}),
    ...(preview.selection ? { selection: invocationSelectionReceipt(preview.selection) } : {}),
    expiresAtMs: preview.expiresAtMs,
  };
}

function invocationStep(step: PageActionResult) {
  return { status: step.status, ...(step.reason !== undefined ? { reason: step.reason } : {}) };
}

export function invocationPageOutcome(outcome: OwnerPageActionOutcome) {
  return {
    status: outcome.status,
    forward: invocationStep(outcome.forward),
    ...(outcome.rollback ? { rollback: invocationStep(outcome.rollback) } : {}),
    ...(outcome.receiptPersistence ? { receiptPersistence: outcome.receiptPersistence } : {}),
  };
}

/** Current-page callbacks carry observations, never owner consent capabilities or page coordinates. */
export function currentPageInvocationView(view: Extract<OwnerPageActionView, { kind: 'available' }>) {
  return {
    kind: 'available' as const,
    callId: view.callId,
    generation: view.generation,
    requestMessageId: view.requestMessageId,
    requestText: view.requestText,
    pageSelection: true as const,
    state: view.state,
    ...(view.preview ? { preview: invocationConsent(view.preview) } : {}),
    ...(view.result ? { result: invocationPageOutcome(view.result) } : {}),
    ...(view.resultRequestMessageId !== undefined ? { resultRequestMessageId: view.resultRequestMessageId } : {}),
    ...(view.resultObservedAtMs !== undefined ? { resultObservedAtMs: view.resultObservedAtMs } : {}),
    ...(view.selectionNotice
      ? {
          selectionNotice: {
            requestMessageId: view.selectionNotice.requestMessageId,
            kind: view.selectionNotice.kind,
            reason: view.selectionNotice.reason,
            ...(view.selectionNotice.selection
              ? { selection: invocationSelectionReceipt(view.selectionNotice.selection) }
              : {}),
          },
        }
      : {}),
  };
}

export type OwnerPageInvocationView = OwnerPageActionView | ReturnType<typeof currentPageInvocationView>;

export function projectOwnerPageInvocation(view: OwnerPageActionView): OwnerPageInvocationView {
  return view.kind === 'available' && view.pageSelection ? currentPageInvocationView(view) : view;
}
