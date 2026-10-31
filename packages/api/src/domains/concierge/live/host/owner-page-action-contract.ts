import type { Page } from 'puppeteer-core';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { CdpPageActionSpec } from '../../action/CdpPageActionPort.js';
import type { JevSelectionReceipt } from '../../action/jev/JevPageSelector.js';
import type { OwnerCurrentPageSource } from '../../action/jev/OwnerCurrentPageSource.js';
import type { LivePageActionPort, LivePageActionSelector } from '../../action/LivePageAction.js';
import type { PageActionResult, PageOperation, PageSnapshot } from '../../action/PageActionLoop.js';
import type { LiveCompanionCall } from '../LiveCompanionCall.js';
import type { LiveCompanionSessions } from '../LiveCompanionSessions.js';
import type { LiveContextScope } from './live-controlled-context.js';
import type { LivePageActionApprovalLedger } from './page-action/live-page-action-approval-ledger.js';

export interface OwnerPageAction {
  readonly targetId: string;
  readonly operation: PageOperation;
  readonly value?: string;
  readonly fingerprint: string;
  readonly expectedReadback?: string;
}

export interface OwnerPageActionPlan {
  readonly profileId: string;
  readonly url: string;
  readonly origin: string;
  readonly beforeReadback: string;
  readonly action: OwnerPageAction;
  readonly selection?: JevSelectionReceipt;
  readonly consent: {
    readonly pageUrl: string;
    readonly field: string;
    readonly value?: string;
    readonly restoreValue?: string;
  };
}

/** Named, code-owned page policy. HTTP callers never supply URL, selectors, or a browser. */
export interface OwnerPageActionProfile {
  readonly profileId: string;
  readonly url: string;
  readonly spec: CdpPageActionSpec;
  readonly restoreAfterAction?: boolean;
  prepare(
    snapshot: PageSnapshot,
    request?: { utterance: string; signal: AbortSignal },
  ): OwnerPageActionPlan | Promise<OwnerPageActionPlan>;
  rollback(plan: OwnerPageActionPlan, result: PageActionResult, snapshot: PageSnapshot): OwnerPageAction;
  selector(action: OwnerPageAction): LivePageActionSelector;
}

export interface OwnerPageHandle {
  readonly page: Page;
  close(): Promise<void>;
}

export interface OwnerPageConnector {
  open(profile: OwnerPageActionProfile, signal: AbortSignal): Promise<OwnerPageHandle>;
}

export interface OwnerPageActionDeps {
  readonly ownerUserId: string;
  readonly sessions: LiveCompanionSessions;
  readonly messages: Pick<IMessageStore, 'getByThread'>;
  readonly profile?: OwnerPageActionProfile;
  readonly connector?: OwnerPageConnector;
  readonly currentPages?: OwnerCurrentPageSource;
  readonly recordResult?: (input: {
    scope: LiveContextScope;
    requestMessageId: string;
    body: string;
    receiptId: string;
  }) => Promise<void | string>;
}

export interface CurrentPageRequest {
  call: LiveCompanionCall;
  scope: LiveContextScope;
  request: { sourceRef: string; revision: string; text: string };
}

export interface OwnerPagePreview {
  readonly id: string;
  readonly callId: string;
  readonly scope: LiveContextScope;
  readonly requestMessageId: string;
  readonly requestRevision: string;
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  readonly expiresAtMs: number;
  readonly plan: OwnerPageActionPlan;
  readonly profile?: OwnerPageActionProfile;
  readonly handle: OwnerPageHandle;
  readonly port: LivePageActionPort & { close(): Promise<void> };
  disarmLifetime?: () => void;
  revoked?: boolean;
  state: 'awaiting_consent' | 'executing' | 'settled';
  approvalId?: string;
  rollbackApprovalId?: string;
  outcome?: OwnerPageActionOutcome;
}

export interface OwnerPageCallEntry {
  readonly call: LiveCompanionCall;
  readonly ledger: LivePageActionApprovalLedger;
  inspecting: boolean;
  preview?: OwnerPagePreview;
  lastReceipt?: {
    previewId: string;
    requestMessageId: string;
    observedAtMs: number;
    outcome: OwnerPageActionOutcome;
  };
  selectionNotice?: {
    requestMessageId: string;
    kind: 'ask' | 'none' | 'unavailable';
    reason: string;
    selection?: JevSelectionReceipt;
  };
}

export type OwnerPageActionView =
  | { kind: 'unavailable' }
  | {
      kind: 'available';
      callId: string;
      generation: number;
      requestMessageId: string;
      requestText: string;
      profileId: string;
      pageUrl: string;
      pageSelection?: boolean;
      state: 'ready' | 'inspecting' | 'awaiting_consent' | 'executing' | 'settled';
      preview?: OwnerPageActionConsent;
      result?: OwnerPageActionOutcome;
      resultRequestMessageId?: string;
      resultObservedAtMs?: number;
      selectionNotice?: OwnerPageCallEntry['selectionNotice'];
    };

export interface OwnerPageActionConsent {
  readonly previewId: string;
  readonly pageUrl: string;
  readonly field: string;
  readonly fieldSelector: string;
  readonly readbackSelector: string;
  readonly operation?: PageOperation;
  readonly value?: string;
  readonly expectedReadback?: string;
  readonly restoreValue?: string;
  readonly selection?: JevSelectionReceipt;
  readonly expiresAtMs: number;
  readonly permissionScope: string;
}

export interface OwnerPageActionOutcome {
  readonly status: 'applied' | 'restored' | 'no_effect' | 'cancelled' | 'denied' | 'unknown';
  readonly forward: PageActionResult;
  readonly rollback?: PageActionResult;
  readonly receiptPersistence?: 'stored' | 'unconfirmed';
}
