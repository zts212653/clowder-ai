import { randomUUID } from 'node:crypto';
import type { CallbackPrincipal } from '@cat-cafe/shared';
import { JevSelectionNotice } from '../../action/jev/JevPageSelector.js';
import type { LiveCompanionCall } from '../LiveCompanionCall.js';
import { whileNotAborted } from './live-controlled-context.js';
import type {
  CurrentPageRequest,
  OwnerPageActionConsent,
  OwnerPageActionDeps,
  OwnerPageActionOutcome,
  OwnerPageActionView,
  OwnerPageCallEntry,
  OwnerPagePreview,
} from './owner-page-action-contract.js';
import { executeApprovedPageAction, forwardOutcome, restoreAppliedPageAction } from './owner-page-action-execution.js';
import { LivePageActionApprovalLedger } from './page-action/live-page-action-approval-ledger.js';
import { sameScope } from './page-action/live-page-action-authority-contract.js';
import {
  listOwnerPageChoices,
  ownerPageInvocationView,
  readCurrentOwnerPageRequest,
} from './page-action/owner-page-action-access.js';
import { prepareOwnerPageAction } from './page-action/owner-page-action-prepare.js';
import {
  armOwnerPagePreview,
  canInspect,
  closePreview,
  closeResources,
  consent,
  pageResultView,
  rememberPageOutcome,
  settlePageOutcome,
  validPlan,
} from './page-action/owner-page-action-support.js';

const PREVIEW_MS = 60_000,
  INSPECTION_MS = 5_000;

/** One owner consent can use one current direct request and one Host-selected page. */
export class OwnerPageActionService {
  private readonly calls = new Map<string, OwnerPageCallEntry>();

  constructor(
    private readonly deps: OwnerPageActionDeps,
    private readonly timing: { previewMs: number } = { previewMs: PREVIEW_MS },
  ) {
    if (!Number.isSafeInteger(timing.previewMs) || timing.previewMs < 1 || timing.previewMs > PREVIEW_MS)
      throw new Error('Invalid page-action preview lifetime');
  }

  get enabled(): boolean {
    return Boolean(this.deps.currentPages || (this.deps.profile && this.deps.connector));
  }

  newLedger(): LivePageActionApprovalLedger {
    return new LivePageActionApprovalLedger();
  }

  bindCall(call: LiveCompanionCall, ledger: LivePageActionApprovalLedger): void {
    const entry: OwnerPageCallEntry = { call, ledger, inspecting: false };
    this.calls.set(call.id, entry);
    void call.finished
      .finally(() => {
        if (this.calls.get(call.id) !== entry) return;
        this.revoke(entry);
        this.deps.currentPages?.clear(call.id);
        this.calls.delete(call.id);
      })
      .catch(() => {});
  }

  private async current(requestMessageId: string): Promise<CurrentPageRequest | null> {
    return readCurrentOwnerPageRequest(this.deps, this.calls, requestMessageId);
  }

  private alignPreview(entry: OwnerPageCallEntry, sourceId: string): boolean {
    const preview = entry.preview;
    if (!preview) return true;
    if (preview.requestMessageId !== sourceId) {
      if (preview.state === 'executing') {
        this.revoke(entry);
        return false;
      }
      if (preview.state === 'awaiting_consent') this.revoke(entry);
      else entry.preview = undefined;
      return true;
    }
    if ((preview.signal.aborted || Date.now() >= preview.expiresAtMs) && preview.state !== 'settled')
      this.revoke(entry);
    return true;
  }

  async view(): Promise<OwnerPageActionView> {
    const profile = this.deps.profile;
    if (!this.enabled) return { kind: 'unavailable' };
    const observed = await this.deps.sessions.observeCall(this.deps.ownerUserId);
    if (!observed) return { kind: 'unavailable' };
    const entry = this.calls.get(observed.callId);
    if (!entry) return { kind: 'unavailable' };
    const recent = await this.deps.messages.getByThread(observed.threadId, 256, observed.userId, {
      includeQueuedUserMessages: true,
      includeRecalledUserMessages: true,
    });
    const source = recent.filter((item) => item.userId === observed.userId && item.catId === null).at(-1);
    if (!source) return { kind: 'unavailable' };
    const current = await this.current(source.id);
    if (!current) return { kind: 'unavailable' };
    if (!this.alignPreview(entry, source.id)) return { kind: 'unavailable' };
    const selected = this.deps.currentPages?.selected(current);
    const activeProfile = (entry.preview?.state !== 'settled' ? entry.preview?.profile : undefined) ?? profile;
    return {
      kind: 'available',
      callId: observed.callId,
      generation: observed.generation,
      requestMessageId: source.id,
      requestText: current.request.text,
      profileId: activeProfile?.profileId ?? this.deps.currentPages?.profileId ?? '',
      pageUrl: activeProfile?.url ?? selected?.url ?? '',
      ...(this.deps.currentPages ? { pageSelection: true } : {}),
      state: entry.inspecting ? 'inspecting' : (entry.preview?.state ?? 'ready'),
      ...(entry.preview && activeProfile && entry.preview.state !== 'settled'
        ? { preview: consent(entry.preview, activeProfile) }
        : {}),
      ...pageResultView(entry),
      ...(entry.selectionNotice?.requestMessageId === source.id ? { selectionNotice: entry.selectionNotice } : {}),
    };
  }

  async forInvocation(principal: Extract<CallbackPrincipal, { kind: 'invocation' }>) {
    return ownerPageInvocationView(this.deps, this.calls, this.enabled, principal, () => this.view());
  }

  async listPages(requestMessageId: string) {
    const current = await this.current(requestMessageId);
    const entry = current && this.calls.get(current.call.id);
    if (!entry || entry.inspecting || entry.preview?.state === 'executing') throw new Error('Page selection is busy');
    if (entry.preview) this.revoke(entry);
    const pages = await listOwnerPageChoices(this.deps, current);
    const verified = await this.current(requestMessageId);
    if (
      !current ||
      !verified ||
      !sameScope(verified.scope, current.scope) ||
      verified.request.revision !== current.request.revision
    )
      throw new Error('Owner request changed');
    return pages;
  }

  async selectPage(requestMessageId: string, pageId: string) {
    const current = await this.current(requestMessageId);
    const entry = current && this.calls.get(current.call.id);
    if (!current || !entry || entry.inspecting || entry.preview?.state === 'executing' || !this.deps.currentPages)
      throw new Error('Current page cannot be changed now');
    if (entry.preview) this.revoke(entry);
    this.deps.currentPages.choose(current, pageId);
    return this.inspect(requestMessageId, pageId);
  }

  async inspect(requestMessageId: string, selectionId?: string): Promise<OwnerPageActionConsent> {
    if (!this.enabled) throw new Error('Page action unavailable');
    const current = await this.current(requestMessageId);
    if (!current) throw new Error('Direct owner request unavailable');
    const entry = this.calls.get(current.call.id);
    const signal = current.call.boundaryContexts.pageActionPreviewSignal();
    if (!canInspect(entry, signal) || !entry || !signal) throw new Error('Page action unavailable');
    if (entry.preview) this.revoke(entry);
    entry.inspecting = true;
    entry.selectionNotice = undefined;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(INSPECTION_MS)]);
    let handle: OwnerPagePreview['handle'] | undefined;
    let port: OwnerPagePreview['port'] | undefined;
    try {
      const prepared = await prepareOwnerPageAction(this.deps, current, boundedSignal, selectionId);
      const { profile, snapshot, plan } = prepared;
      handle = prepared.handle;
      port = prepared.port;
      if (!validPlan(profile, snapshot, plan)) throw new Error('Named page changed');
      if (plan.selection) {
        if (!this.deps.recordResult) throw new Error('Durable Jev receipt unavailable');
        await whileNotAborted(
          boundedSignal,
          this.deps.recordResult({
            scope: current.scope,
            requestMessageId,
            body: JSON.stringify({
              kind: 'host_page_action_selection',
              selection: plan.selection,
              effect: 'not_executed',
            }),
            receiptId: plan.selection.requestId,
          }),
        );
      }
      const verified = await this.current(requestMessageId);
      if (
        !verified ||
        !sameScope(verified.scope, current.scope) ||
        verified.request.revision !== current.request.revision ||
        signal.aborted ||
        boundedSignal.aborted
      )
        throw new Error('Direct owner request changed');
      const controller = new AbortController();
      const preview: OwnerPagePreview = {
        id: randomUUID(),
        callId: current.call.id,
        scope: current.scope,
        requestMessageId,
        requestRevision: current.request.revision,
        signal: AbortSignal.any([signal, controller.signal]),
        controller,
        expiresAtMs: Date.now() + this.timing.previewMs,
        plan,
        profile,
        handle,
        port,
        state: 'awaiting_consent',
      };
      entry.preview = preview;
      armOwnerPagePreview(preview, () => {
        if (entry.preview === preview) this.revoke(entry);
      });
      return consent(preview, profile);
    } catch (error) {
      if (this.deps.currentPages || this.deps.profile?.restoreAfterAction === false) {
        entry.selectionNotice = {
          requestMessageId,
          kind: error instanceof JevSelectionNotice ? error.choice.kind : 'unavailable',
          reason: error instanceof JevSelectionNotice ? error.choice.reason : 'Jev 页面选择未确认；尚未操作页面。',
          ...(error instanceof JevSelectionNotice ? { selection: error.receipt } : {}),
        };
        if (error instanceof JevSelectionNotice)
          await this.deps
            .recordResult?.({
              scope: current.scope,
              requestMessageId,
              body: JSON.stringify({
                kind: 'host_page_action_selection',
                selection: error.receipt,
                effect: 'not_executed',
              }),
              receiptId: error.receipt.requestId,
            })
            .catch(() => {});
      }
      if (handle) await closeResources(handle, port);
      throw error;
    } finally {
      entry.inspecting = false;
    }
  }

  async confirm(previewId: string): Promise<OwnerPageActionOutcome> {
    const entry = [...this.calls.values()].find((item) => item.preview?.id === previewId);
    const preview = entry?.preview;
    const profile = preview?.profile ?? this.deps.profile;
    if (!entry || !preview || !profile || preview.state !== 'awaiting_consent')
      throw new Error('Page action preview unavailable');
    preview.state = 'executing';
    let outcome: OwnerPageActionOutcome = {
      status: 'unknown',
      forward: { status: 'unknown', before: preview.plan.beforeReadback, reason: 'owner_action_unconfirmed' },
    };
    let forwardPortTransferred = false;
    try {
      const current = await this.current(preview.requestMessageId);
      if (
        preview.signal.aborted ||
        Date.now() >= preview.expiresAtMs ||
        !current ||
        !sameScope(current.scope, preview.scope) ||
        current.request.revision !== preview.requestRevision
      )
        throw new Error('Direct owner request changed');
      const forward = await executeApprovedPageAction({
        entry,
        preview,
        profile,
        action: preview.plan.action,
        port: preview.port,
        step: 'forward',
        onPortTransferred: () => {
          forwardPortTransferred = true;
        },
      });
      outcome = forwardOutcome(forward);
      if (forward.status === 'applied' && profile.restoreAfterAction === false)
        outcome = { status: 'applied', forward };
      if (forward.status === 'applied' && !preview.signal.aborted && profile.restoreAfterAction !== false) {
        const rollback = await restoreAppliedPageAction(entry, preview, profile, forward);
        outcome = {
          status:
            rollback.status === 'applied' && rollback.after === preview.plan.beforeReadback ? 'restored' : 'unknown',
          forward,
          rollback,
        };
      }
    } catch {
      // An action may already have passed the browser commit fence. Never auto-retry.
    } finally {
      preview.disarmLifetime?.();
      if (preview.approvalId) entry.ledger.revoke(preview.approvalId);
      if (preview.rollbackApprovalId) entry.ledger.revoke(preview.rollbackApprovalId);
      const closed = await closePreview(preview, !forwardPortTransferred);
      if (!closed) outcome = { ...outcome, status: 'unknown' };
      preview.state = 'settled';
      rememberPageOutcome(entry, preview, outcome);
    }
    return settlePageOutcome(this.deps, entry, preview, outcome);
  }

  cancel(previewId: string): void {
    const entry = [...this.calls.values()].find((item) => item.preview?.id === previewId);
    if (!entry) throw new Error('Page action preview unavailable');
    this.revoke(entry);
  }

  private revoke(entry: OwnerPageCallEntry): void {
    const preview = entry.preview;
    if (!preview || preview.state === 'settled' || preview.revoked) return;
    preview.revoked = true;
    preview.disarmLifetime?.();
    preview.controller.abort('owner_cancelled');
    if (preview.approvalId) entry.call.boundaryContexts.revokePageAction(preview.approvalId);
    if (preview.rollbackApprovalId) entry.call.boundaryContexts.revokePageAction(preview.rollbackApprovalId);
    if (preview.state === 'awaiting_consent') {
      void closePreview(preview);
      entry.preview = undefined;
    }
  }

  async close(): Promise<void> {
    for (const entry of this.calls.values()) {
      this.revoke(entry);
      this.deps.currentPages?.clear(entry.call.id);
    }
    this.calls.clear();
  }
}
