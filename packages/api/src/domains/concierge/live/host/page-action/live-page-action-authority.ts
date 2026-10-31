import { randomUUID } from 'node:crypto';
import {
  type LivePageActionCurrent,
  type LivePageActionGrant,
  type LivePageActionSelector,
  pageActionGrantSha256,
  runLivePageAction,
} from '../../../action/LivePageAction.js';
import type { PageActionResult } from '../../../action/PageActionLoop.js';
import { type LiveContextScope, whileNotAborted } from '../live-controlled-context.js';
import { isLatestOwnerMessage } from '../voice/live-owner-currentness.js';
import {
  type ActiveAction,
  type ClosableLivePageActionPort,
  closePort,
  directOwner,
  type LivePageActionAuthorityDeps,
  sameScope,
  sha256,
  type TrustedPageActionApproval,
  validApproval,
} from './live-page-action-authority-contract.js';

const MAX_APPROVALS_PER_CALL = 64;

export type {
  ClosableLivePageActionPort,
  LivePageActionAuthorityDeps,
  TrustedPageActionApproval,
} from './live-page-action-authority-contract.js';

/** Host-only authority. No product route constructs this until an owner approval source exists. */
export class LivePageActionAuthority {
  private readonly controller = new AbortController();
  private ownerPreviewController = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly consumedApprovalIds = new Set<string>();
  private active?: ActiveAction;
  private staging = false;
  private stagingController?: AbortController;
  private stagingApprovalId?: string;
  private requiresFreshDirectRequest = false;
  private interruptionEpoch = 0;
  private acceptedAfterInterruptionId?: string;

  constructor(private readonly deps: LivePageActionAuthorityDeps) {}

  previewSignal(): AbortSignal {
    return this.ownerPreviewController.signal;
  }

  /** Owner preview uses the exact source fence that action admission will recheck. */
  async inspectRequest(id: string) {
    const scope = this.deps.currentScope();
    if (!scope || this.controller.signal.aborted || this.ownerPreviewController.signal.aborted) return null;
    try {
      const request = await this.readRequest(scope, id, this.ownerPreviewController.signal);
      return request ? { scope, request } : null;
    } catch {
      return null;
    }
  }

  async stage(input: {
    requestMessageId: string;
    approval: TrustedPageActionApproval;
    port: ClosableLivePageActionPort;
  }): Promise<string> {
    if (
      this.controller.signal.aborted ||
      this.active ||
      this.staging ||
      this.consumedApprovalIds.size >= MAX_APPROVALS_PER_CALL ||
      this.consumedApprovalIds.has(input.approval.approvalId) ||
      (this.requiresFreshDirectRequest && input.requestMessageId !== this.acceptedAfterInterruptionId)
    ) {
      await closePort(input.port);
      throw new Error('Page action unavailable');
    }
    this.staging = true;
    const stagingController = new AbortController();
    this.stagingController = stagingController;
    this.stagingApprovalId = input.approval.approvalId;
    let admitted = false;
    try {
      const authorityId = await this.deps.run(() =>
        this.admit(input, AbortSignal.any([this.controller.signal, stagingController.signal])),
      );
      admitted = true;
      return authorityId;
    } finally {
      this.staging = false;
      this.stagingController = undefined;
      this.stagingApprovalId = undefined;
      if (!admitted) await closePort(input.port);
    }
  }

  private async admit(
    input: {
      requestMessageId: string;
      approval: TrustedPageActionApproval;
      port: ClosableLivePageActionPort;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const scope = this.deps.currentScope();
    if (!scope || !validApproval(input.approval, Date.now())) throw new Error('Page action not approved');
    const request = await this.readRequest(scope, input.requestMessageId, signal);
    if (!request) throw new Error('Direct owner request unavailable');
    const snapshot = await whileNotAborted(signal, input.port.inspect());
    if (snapshot.origin !== input.approval.origin || snapshot.url !== input.approval.url)
      throw new Error('Approved page changed');
    const target = snapshot.candidates.find(
      (item) => item.id === input.approval.targetId && item.operation === input.approval.operation,
    );
    if (!target || !/^sha256:[0-9a-f]{64}$/.test(target.fingerprint)) throw new Error('Approved target unavailable');
    const entry = this.createEntry(input, scope, request, target.fingerprint);
    if (!(await this.approved(entry, signal))) throw new Error('Page action approval unavailable');
    const current = this.deps.currentScope();
    if (!current || !sameScope(current, scope)) throw new Error('Live call changed during page approval');
    if (!(await this.readRequest(scope, input.requestMessageId, signal)))
      throw new Error('Direct request changed during page approval');
    if (this.active || signal.aborted) throw new Error('Page action unavailable');
    this.active = entry;
    this.consumedApprovalIds.add(entry.approvalId);
    return entry.authorityId;
  }

  private createEntry(
    input: {
      requestMessageId: string;
      approval: TrustedPageActionApproval;
      port: ClosableLivePageActionPort;
    },
    scope: LiveContextScope,
    request: ActiveAction['request'],
    fingerprint: string,
  ): ActiveAction {
    const approval = input.approval;
    const grant: LivePageActionGrant = {
      authorityId: randomUUID(),
      permissionScope: approval.permissionScope,
      expiresAtMs: approval.expiresAtMs,
      action: {
        origin: approval.origin,
        url: approval.url,
        requestRevision: request.revision,
        actions: [
          {
            targetId: approval.targetId,
            operation: approval.operation,
            ...(approval.value === undefined ? {} : { value: approval.value }),
            fingerprint,
            expectedReadback: approval.expectedReadback,
          },
        ],
      },
    };
    return {
      authorityId: grant.authorityId,
      scope: Object.freeze({ ...scope }),
      requestMessageId: input.requestMessageId,
      request,
      approvalId: approval.approvalId,
      grant,
      port: input.port,
      controller: new AbortController(),
      executing: false,
    };
  }

  async execute(authorityId: string, selector: LivePageActionSelector): Promise<PageActionResult> {
    const entry = this.active;
    if (!entry || entry.authorityId !== authorityId || entry.executing || this.controller.signal.aborted)
      throw new Error('Page action unavailable');
    entry.executing = true;
    let entered = false;
    const pending = this.deps.run(async () => {
      entered = true;
      return runLivePageAction({
        admission: {
          scope: entry.scope,
          request: entry.request,
          grant: entry.grant,
          signal: AbortSignal.any([this.controller.signal, entry.controller.signal]),
          readCurrent: (_binding, signal) => this.readCurrent(entry, signal),
        },
        selector,
        port: entry.port,
      });
    });
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
      entry.controller.abort('settled');
      if (this.active === entry) this.active = undefined;
      if (!entered) await closePort(entry.port);
    }
  }

  revoke(approvalId: string): void {
    if (this.stagingApprovalId === approvalId) {
      this.consumedApprovalIds.add(approvalId);
      this.stagingController?.abort('approval_revoked');
    }
    if (this.active?.approvalId === approvalId) this.abortActive('approval_revoked');
  }

  interrupt(): number {
    this.interruptionEpoch++;
    this.ownerPreviewController.abort('user_interrupted');
    this.ownerPreviewController = new AbortController();
    this.requiresFreshDirectRequest = true;
    this.acceptedAfterInterruptionId = undefined;
    if (this.stagingApprovalId) this.consumedApprovalIds.add(this.stagingApprovalId);
    this.stagingController?.abort('user_interrupted');
    this.abortActive('user_interrupted');
    return this.interruptionEpoch;
  }

  noteAcceptedDirectRequest(messageId: string, epoch: number): void {
    if (!this.controller.signal.aborted && epoch === this.interruptionEpoch && /^[A-Za-z0-9_-]{1,160}$/.test(messageId))
      this.acceptedAfterInterruptionId = messageId;
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort('call_closed');
    this.ownerPreviewController.abort('call_closed');
    this.stagingController?.abort('call_closed');
    this.abortActive('call_closed');
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private abortActive(reason: string): void {
    const entry = this.active;
    if (!entry) return;
    entry.controller.abort(reason);
    if (entry.executing) return;
    this.active = undefined;
    const pending = closePort(entry.port);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
  }

  private async readRequest(scope: LiveContextScope, id: string, signal: AbortSignal) {
    const current = this.deps.currentScope();
    if (signal.aborted || !current || !sameScope(current, scope)) return null;
    if (!(await whileNotAborted(signal, this.deps.isCurrentThread(scope.userId, scope.threadId)))) return null;
    if (!(await whileNotAborted(signal, this.deps.verifyCompanion()))) return null;
    const source = await whileNotAborted(signal, Promise.resolve(this.deps.messages.getById(id)));
    if (!source || this.deps.isHostAdmissionSource?.(source.id)) return null;
    if (!directOwner(source, scope, this.deps.isAcceptedDirectVoice?.(source))) return null;
    if (this.requiresFreshDirectRequest && source.id !== this.acceptedAfterInterruptionId) return null;
    if (!(await whileNotAborted(signal, isLatestOwnerMessage(this.deps.messages, scope, source)))) return null;
    return {
      sourceRef: `${scope.threadId}#${source.id}`,
      revision: sha256(JSON.stringify([source.id, source.content])),
      text: source.content,
    };
  }

  private async approved(entry: ActiveAction, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || Date.now() >= entry.grant.expiresAtMs) return false;
    const valid = await whileNotAborted(
      signal,
      this.deps.verifyApproval({
        approvalId: entry.approvalId,
        scope: entry.scope,
        requestSourceRef: entry.request.sourceRef,
        requestRevision: entry.request.revision,
        actionSha256: pageActionGrantSha256(entry.grant.action),
        permissionScope: entry.grant.permissionScope,
        expiresAtMs: entry.grant.expiresAtMs,
        signal,
      }),
    );
    return valid && !signal.aborted && Date.now() < entry.grant.expiresAtMs;
  }

  private async readCurrent(entry: ActiveAction, signal: AbortSignal): Promise<LivePageActionCurrent | null> {
    if (this.active !== entry || this.controller.signal.aborted || entry.controller.signal.aborted) return null;
    const scope = this.deps.currentScope();
    if (!scope || !sameScope(scope, entry.scope)) return null;
    const request = await this.readRequest(entry.scope, entry.requestMessageId, signal);
    if (!request || !(await this.approved(entry, signal))) return null;
    return {
      scope,
      request: {
        sourceRef: request.sourceRef,
        revision: request.revision,
        textSha256: sha256(request.text),
        kind: 'direct_owner',
      },
      grant: {
        authorityId: entry.grant.authorityId,
        permissionScope: entry.grant.permissionScope,
        expiresAtMs: entry.grant.expiresAtMs,
        actionSha256: pageActionGrantSha256(entry.grant.action),
      },
    };
  }
}
