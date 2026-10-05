import type { CodexAppServerJsonObject } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { LivePageActionSelector } from '../../action/LivePageAction.js';
import type { PageActionResult } from '../../action/PageActionLoop.js';
import type { F317LiveCallObservation, F317MeetingGrant } from '../../meeting/f317-meeting-admission.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import { type LiveContextGate, whileNotAborted } from './live-controlled-context.js';
import { bindLiveInboxHost, type LiveInboxHost } from './live-inbox-host.js';
import { type LiveMeetingDependencies, LiveMeetingHost } from './live-meeting-host.js';
import { LivePageActionApprovalLedger } from './live-page-action-approval-ledger.js';
import {
  type ClosableLivePageActionPort,
  LivePageActionAuthority,
  type TrustedPageActionApproval,
} from './live-page-action-authority.js';
import { closePort } from './live-page-action-authority-contract.js';
import { bindLiveRecoveryHost } from './live-recovery-binding.js';
import type { LiveRecoveryHost } from './live-recovery-host.js';

/** One native boundary admits at most one independent source-backed context. */
export class LiveBoundaryContexts {
  private inbox?: LiveInboxHost;
  private recovery?: LiveRecoveryHost;
  private pendingMeeting?: LiveMeetingHost;
  private meeting?: LiveMeetingHost;
  private pageActions?: LivePageActionAuthority;
  private callbackInvocationId?: string;
  private userSpeaking = false;
  private closed = false;

  constructor(
    private readonly options: LiveCompanionCallOptions,
    private readonly context: LiveContextGate,
    private readonly wakeNative: () => void,
    private readonly isSameCallExposure: (message: StoredMessage) => boolean,
    private readonly runAction?: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  configure(callbackEnv: Record<string, string>): void {
    const input = {
      options: this.options,
      context: this.context,
      callbackEnv,
      wakeNative: this.wakeNative,
      isSameCallExposure: this.isSameCallExposure,
    };
    this.inbox ??= bindLiveInboxHost(input);
    this.recovery ??= bindLiveRecoveryHost(input);
    this.callbackInvocationId = callbackEnv.CAT_CAFE_INVOCATION_ID;
    const pageAction = this.options.pageAction;
    if (pageAction && !this.pageActions) {
      if (!this.runAction) throw new Error('Page action carrier fence unavailable');
      const ledger = pageAction.approvalLedger;
      if (!(ledger instanceof LivePageActionApprovalLedger)) throw new Error('Page action approval ledger unavailable');
      const authority = new LivePageActionAuthority({
        messages: pageAction.messages,
        isCurrentThread: pageAction.isCurrentThread,
        verifyApproval: (input) => ledger.verify(input),
        isHostAdmissionSource: (id) => ledger.isHostAdmissionSource(id),
        currentScope: () => {
          const invocationId = this.callbackInvocationId;
          const binding = this.options.binding;
          return invocationId
            ? this.context.scope({ invocationId, catId: binding.catId, threadId: binding.threadId })
            : null;
        },
        verifyCompanion: () => this.options.verifyCompanion?.() ?? Promise.resolve(true),
        run: this.runAction,
      });
      ledger.bindRevocation((approvalId) => authority.revoke(approvalId));
      this.pageActions = authority;
    }
  }

  /** Internal Host seam; no page actor or approval ledger is installed by the Live route. */
  async runPageAction(input: {
    requestMessageId: string;
    approval: TrustedPageActionApproval;
    port: ClosableLivePageActionPort;
    selector: LivePageActionSelector;
  }): Promise<PageActionResult> {
    if (this.closed || this.userSpeaking || !this.pageActions) {
      await closePort(input.port);
      throw new Error('Page action unavailable');
    }
    const authorityId = await this.pageActions.stage(input);
    return this.pageActions.execute(authorityId, input.selector);
  }

  async inspectPageActionRequest(id: string) {
    if (this.closed || this.userSpeaking) return null;
    return this.pageActions?.inspectRequest(id) ?? null;
  }

  pageActionPreviewSignal(): AbortSignal | null {
    return this.closed || this.userSpeaking ? null : (this.pageActions?.previewSignal() ?? null);
  }

  revokePageAction(approvalId: string): void {
    const ledger = this.options.pageAction?.approvalLedger;
    if (ledger instanceof LivePageActionApprovalLedger) ledger.revoke(approvalId);
    this.pageActions?.revoke(approvalId);
  }

  interruptPageAction(): number | undefined {
    return this.pageActions?.interrupt();
  }

  noteAcceptedDirectText(messageId: string, epoch: number): void {
    this.pageActions?.noteAcceptedDirectText(messageId, epoch);
  }

  async drainPageAction(): Promise<void> {
    await this.pageActions?.drain();
  }

  observeCall(): F317LiveCallObservation | null {
    if (this.closed) return null;
    const invocationId = this.callbackInvocationId;
    if (!invocationId) return null;
    const binding = this.options.binding;
    const scope = this.context.scope({ invocationId, catId: binding.catId, threadId: binding.threadId });
    return scope ? { ...binding, generation: scope.generation, state: 'talking' } : null;
  }

  async attachMeeting(
    grant: F317MeetingGrant,
    verify: () => Promise<boolean>,
    deps: LiveMeetingDependencies,
  ): Promise<void> {
    const call = this.observeCall();
    const invocationId = this.callbackInvocationId;
    if (
      this.closed ||
      !call ||
      !invocationId ||
      call.userId !== grant.userId ||
      call.threadId !== grant.liveThreadId ||
      call.catId !== grant.catId ||
      call.callId !== grant.callId ||
      call.generation !== grant.generation ||
      grant.signal.aborted
    )
      throw new Error('meeting_share_not_admitted');
    const scope = this.context.scope({ invocationId, catId: call.catId, threadId: call.threadId });
    if (!scope) throw new Error('meeting_share_not_admitted');
    this.pendingMeeting?.close();
    this.pendingMeeting = undefined;
    this.meeting?.close();
    this.meeting = undefined;
    let pending: LiveMeetingHost | undefined;
    try {
      const meeting = await LiveMeetingHost.attach(
        {
          scope,
          grant,
          verify,
          ...deps,
          inject: (input) => this.context.inject(input),
          wakeNative: this.wakeNative,
        },
        (host) => {
          pending = host;
          this.pendingMeeting = host;
        },
      );
      const verified = await whileNotAborted(AbortSignal.any([meeting.signal, grant.signal]), verify());
      const current = this.observeCall();
      if (
        !verified ||
        !meeting.isOpenFor(grant) ||
        this.pendingMeeting !== meeting ||
        !current ||
        current.userId !== grant.userId ||
        current.threadId !== grant.liveThreadId ||
        current.catId !== grant.catId ||
        current.callId !== grant.callId ||
        current.generation !== grant.generation
      )
        throw new Error('meeting_share_not_admitted');
      this.pendingMeeting = undefined;
      this.meeting = meeting;
    } catch (error) {
      const revoked = this.closed || grant.signal.aborted || this.pendingMeeting !== pending;
      pending?.close();
      if (this.pendingMeeting === pending) this.pendingMeeting = undefined;
      if (revoked) throw new Error('meeting_share_not_admitted');
      throw error;
    }
  }

  detachMeeting(grant: F317MeetingGrant): void {
    if (this.pendingMeeting?.grantId === grant.grantId) {
      this.pendingMeeting.close();
      this.pendingMeeting = undefined;
    }
    if (this.meeting?.grantId !== grant.grantId) return;
    this.meeting.close();
    this.meeting = undefined;
  }

  isMeetingAttached(grant: F317MeetingGrant): boolean {
    if (this.closed || !this.meeting?.isOpenFor(grant)) return false;
    const call = this.observeCall();
    return Boolean(
      call &&
        call.userId === grant.userId &&
        call.threadId === grant.liveThreadId &&
        call.catId === grant.catId &&
        call.callId === grant.callId &&
        call.generation === grant.generation,
    );
  }

  signalInbox(): void {
    this.inbox?.signal();
  }

  hasPendingWake(): boolean {
    return Boolean(this.meeting?.hasPendingWake() || this.inbox?.hasPendingWake() || this.recovery?.hasPendingWake());
  }

  async atBoundary(kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<void> {
    try {
      const meeting = await this.meeting?.atBoundary();
      if (meeting === 'accepted' || meeting === 'busy') return;
      const inbox = await this.inbox?.atBoundary(kind);
      if (inbox && inbox !== 'idle') {
        // Only an accepted notice generated a native turn; busy or cancelled attempts
        // must leave the current recovery ticket available at a later safe boundary.
        if (inbox === 'accepted') this.recovery?.cancel('inbox_precedence');
        return;
      }
      await this.recovery?.atBoundary();
    } catch (error) {
      this.options.reportInboxFailure?.(error);
    }
  }

  observe(message: CodexAppServerJsonObject): void {
    this.inbox?.observe(message);
    const params = message.params as Record<string, unknown> | undefined;
    const delta = params?.delta;
    if (
      message.method === 'thread/realtime/transcript/delta' &&
      params?.role === 'user' &&
      typeof delta === 'string' &&
      delta.length > 0 &&
      delta.length <= 32_000 &&
      !this.userSpeaking
    ) {
      this.userSpeaking = true;
      this.pageActions?.interrupt();
      this.meeting?.onUserSpeaking();
      this.recovery?.cancel('user_speaking');
    }
    if (message.method === 'thread/realtime/transcript/done' && params?.role === 'user') {
      this.userSpeaking = false;
      this.pageActions?.interrupt();
      this.onUserTurn();
    }
  }

  onUserTurn(): void {
    this.meeting?.onUserTurn();
    this.recovery?.onUserTurn();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pageActions?.close();
    const ledger = this.options.pageAction?.approvalLedger;
    if (ledger instanceof LivePageActionApprovalLedger) ledger.close();
    this.pendingMeeting?.close();
    this.pendingMeeting = undefined;
    this.meeting?.close();
    this.meeting = undefined;
    this.inbox?.close();
    this.recovery?.close();
  }
}
