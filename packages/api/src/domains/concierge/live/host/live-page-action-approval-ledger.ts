import type { LiveContextScope } from './live-controlled-context.js';
import { sameScope } from './live-page-action-authority-contract.js';

const MAX_APPROVALS = 64;
const MAX_LIFETIME_MS = 120_000;
const SHA256 = /^[0-9a-f]{64}$/;

export interface PageActionApprovalRecord {
  readonly approvalId: string;
  readonly scope: LiveContextScope;
  readonly requestSourceRef: string;
  readonly requestRevision: string;
  readonly actionSha256: string;
  readonly permissionScope: string;
  readonly expiresAtMs: number;
}

export type PageActionApprovalProbe = PageActionApprovalRecord & { readonly signal: AbortSignal };

/** Per-call owner approval record. The real issuer is absent until a named application is authorized. */
export class LivePageActionApprovalLedger {
  private readonly records = new Map<string, PageActionApprovalRecord>();
  private readonly retiredIds = new Set<string>();
  private onRevoked?: (approvalId: string) => void;
  private hostAdmissionSourceId?: string;
  private closed = false;

  bindRevocation(handler: (approvalId: string) => void): void {
    if (this.closed || this.onRevoked) throw new Error('Page action approval ledger unavailable');
    this.onRevoked = handler;
  }

  markHostAdmissionSource(messageId: string): void {
    if (
      this.closed ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(messageId) ||
      (this.hostAdmissionSourceId && this.hostAdmissionSourceId !== messageId)
    )
      throw new Error('Live admission source unavailable');
    this.hostAdmissionSourceId = messageId;
  }

  isHostAdmissionSource(messageId: string): boolean {
    return this.hostAdmissionSourceId === messageId;
  }

  issue(record: PageActionApprovalRecord): void {
    const now = Date.now();
    const [threadId, messageId, extra] = record.requestSourceRef.split('#');
    if (
      this.closed ||
      this.records.size + this.retiredIds.size >= MAX_APPROVALS ||
      this.records.has(record.approvalId) ||
      this.retiredIds.has(record.approvalId) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(record.approvalId) ||
      threadId !== record.scope.threadId ||
      !messageId ||
      extra !== undefined ||
      !SHA256.test(record.requestRevision) ||
      !SHA256.test(record.actionSha256) ||
      !record.permissionScope ||
      record.permissionScope.length > 160 ||
      !Number.isSafeInteger(record.expiresAtMs) ||
      record.expiresAtMs <= now ||
      record.expiresAtMs > now + MAX_LIFETIME_MS
    )
      throw new Error('Page action approval unavailable');
    this.records.set(record.approvalId, Object.freeze({ ...record, scope: Object.freeze({ ...record.scope }) }));
  }

  async verify(probe: PageActionApprovalProbe): Promise<boolean> {
    if (this.closed || probe.signal.aborted || Date.now() >= probe.expiresAtMs) return false;
    const record = this.records.get(probe.approvalId);
    return Boolean(
      record &&
        sameScope(record.scope, probe.scope) &&
        record.requestSourceRef === probe.requestSourceRef &&
        record.requestRevision === probe.requestRevision &&
        record.actionSha256 === probe.actionSha256 &&
        record.permissionScope === probe.permissionScope &&
        record.expiresAtMs === probe.expiresAtMs,
    );
  }

  revoke(approvalId: string): void {
    if (!this.records.delete(approvalId)) return;
    this.retiredIds.add(approvalId);
    this.onRevoked?.(approvalId);
  }

  close(): void {
    this.closed = true;
    this.records.clear();
    this.retiredIds.clear();
    this.onRevoked = undefined;
    this.hostAdmissionSourceId = undefined;
  }
}
