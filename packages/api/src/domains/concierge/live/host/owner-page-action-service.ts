import { randomUUID } from 'node:crypto';
import { createCdpPageActionPort } from '../../action/CdpPageActionPort.js';
import type { PageSnapshot } from '../../action/PageActionLoop.js';
import type { LiveCompanionCall } from '../LiveCompanionCall.js';
import { whileNotAborted } from './live-controlled-context.js';
import { LivePageActionApprovalLedger } from './live-page-action-approval-ledger.js';
import { sameScope } from './live-page-action-authority-contract.js';
import type {
  CurrentPageRequest,
  OwnerPageActionConsent,
  OwnerPageActionDeps,
  OwnerPageActionOutcome,
  OwnerPageActionPlan,
  OwnerPageActionProfile,
  OwnerPageActionView,
  OwnerPageCallEntry,
  OwnerPagePreview,
} from './owner-page-action-contract.js';
import { executeApprovedPageAction, forwardOutcome, restoreAppliedPageAction } from './owner-page-action-execution.js';

const PREVIEW_MS = 60_000;
const INSPECTION_MS = 5_000;

function validPlan(profile: OwnerPageActionProfile, snapshot: PageSnapshot, plan: OwnerPageActionPlan): boolean {
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

function canInspect(entry: OwnerPageCallEntry | undefined, signal: AbortSignal | null): boolean {
  return Boolean(entry && signal && !entry.inspecting && (!entry.preview || entry.preview.state === 'settled'));
}

function consent(
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
    value: preview.plan.consent.value,
    expectedReadback: preview.plan.action.expectedReadback,
    restoreValue: preview.plan.consent.restoreValue,
    expiresAtMs: preview.expiresAtMs,
    permissionScope: preview.plan.profileId,
  };
}

async function closeResources(handle: OwnerPagePreview['handle'], port?: OwnerPagePreview['port']): Promise<boolean> {
  const completed = Promise.allSettled([
    ...(port ? [Promise.resolve().then(() => port.close())] : []),
    Promise.resolve().then(() => handle.close()),
  ]);
  const deadline = AbortSignal.timeout(1_000);
  try {
    const results = await whileNotAborted(deadline, completed);
    return results.every((result) => result.status === 'fulfilled');
  } catch {
    return false;
  }
}

function closePreview(preview: OwnerPagePreview, closeActor = true): Promise<boolean> {
  return closeResources(preview.handle, closeActor ? preview.port : undefined);
}

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
    return Boolean(this.deps.profile && this.deps.connector);
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
        this.calls.delete(call.id);
      })
      .catch(() => {});
  }

  private async current(requestMessageId: string): Promise<CurrentPageRequest | null> {
    const observed = await this.deps.sessions.observeCall(this.deps.ownerUserId);
    if (!observed) return null;
    const entry = this.calls.get(observed.callId);
    if (!entry || entry.call.status().state !== 'talking') return null;
    const read = await entry.call.boundaryContexts.inspectPageActionRequest(requestMessageId);
    if (
      !read ||
      read.scope.userId !== observed.userId ||
      read.scope.threadId !== observed.threadId ||
      read.scope.catId !== observed.catId ||
      read.scope.callId !== observed.callId ||
      read.scope.generation !== observed.generation
    )
      return null;
    return { call: entry.call, ...read };
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

  private armPreview(entry: OwnerPageCallEntry, preview: OwnerPagePreview): void {
    const onAbort = () => {
      if (entry.preview === preview) this.revoke(entry);
    };
    const timer = setTimeout(onAbort, Math.max(1, preview.expiresAtMs - Date.now()));
    timer.unref();
    preview.disarmLifetime = () => {
      clearTimeout(timer);
      preview.signal.removeEventListener('abort', onAbort);
    };
    preview.signal.addEventListener('abort', onAbort, { once: true });
    if (preview.signal.aborted) onAbort();
  }

  async view(): Promise<OwnerPageActionView> {
    const profile = this.deps.profile;
    if (!profile || !this.deps.connector) return { kind: 'unavailable' };
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
    return {
      kind: 'available',
      callId: observed.callId,
      generation: observed.generation,
      requestMessageId: source.id,
      requestText: current.request.text,
      profileId: profile.profileId,
      pageUrl: profile.url,
      state: entry.inspecting ? 'inspecting' : (entry.preview?.state ?? 'ready'),
      ...(entry.preview && entry.preview.state !== 'settled' ? { preview: consent(entry.preview, profile) } : {}),
      ...(entry.preview?.outcome ? { result: entry.preview.outcome } : {}),
    };
  }

  async inspect(requestMessageId: string): Promise<OwnerPageActionConsent> {
    const profile = this.deps.profile;
    const connector = this.deps.connector;
    if (!profile || !connector) throw new Error('Page action unavailable');
    const current = await this.current(requestMessageId);
    if (!current) throw new Error('Direct owner request unavailable');
    const entry = this.calls.get(current.call.id);
    const signal = current.call.boundaryContexts.pageActionPreviewSignal();
    if (!canInspect(entry, signal) || !entry || !signal) throw new Error('Page action unavailable');
    if (entry.preview) this.revoke(entry);
    entry.inspecting = true;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(INSPECTION_MS)]);
    const opening = connector.open(profile, boundedSignal);
    let handle: OwnerPagePreview['handle'] | undefined;
    let port: OwnerPagePreview['port'] | undefined;
    try {
      handle = await whileNotAborted(boundedSignal, opening);
      const created = createCdpPageActionPort(handle.page, profile.spec);
      if (!created.close) throw new Error('Page actor cannot be closed');
      port = created as OwnerPagePreview['port'];
      const snapshot = await whileNotAborted(boundedSignal, port.inspect());
      const plan = profile.prepare(snapshot);
      if (!validPlan(profile, snapshot, plan)) throw new Error('Named page changed');
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
        handle,
        port,
        state: 'awaiting_consent',
      };
      entry.preview = preview;
      this.armPreview(entry, preview);
      return consent(preview, profile);
    } catch (error) {
      if (!handle) void opening.then((late) => closeResources(late)).catch(() => {});
      else await closeResources(handle, port);
      throw error;
    } finally {
      entry.inspecting = false;
    }
  }

  async confirm(previewId: string): Promise<OwnerPageActionOutcome> {
    const entry = [...this.calls.values()].find((item) => item.preview?.id === previewId);
    const preview = entry?.preview;
    const profile = this.deps.profile;
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
      if (forward.status === 'applied' && !preview.signal.aborted) {
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
      preview.outcome = outcome;
      preview.state = 'settled';
    }
    return outcome;
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
    for (const entry of this.calls.values()) this.revoke(entry);
    this.calls.clear();
  }
}
