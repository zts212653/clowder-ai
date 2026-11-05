import type { CodexAppServerJsonObject } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { LivePageActionSelector } from '../../action/LivePageAction.js';
import type { PageActionResult } from '../../action/PageActionLoop.js';
import type { F317LiveCallObservation, F317MeetingGrant } from '../../meeting/f317-meeting-admission.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import { type LiveContextGate, whileNotAborted } from './live-controlled-context.js';
import { type LiveMeetingDependencies, LiveMeetingHost } from './live-meeting-host.js';
import { bindLiveRecoveryHost } from './live-recovery-binding.js';
import type { LiveRecoveryHost } from './live-recovery-host.js';
import { LivePageActionApprovalLedger } from './page-action/live-page-action-approval-ledger.js';
import {
  type ClosableLivePageActionPort,
  LivePageActionAuthority,
  type TrustedPageActionApproval,
} from './page-action/live-page-action-authority.js';
import { closePort } from './page-action/live-page-action-authority-contract.js';
import { LivePageResultHost, type LivePageResultNotice } from './page-action/live-page-result-host.js';
import { LiveOwnerVoiceContext } from './voice/live-owner-voice.js';
import { ownerVoiceScope } from './voice/live-owner-voice-source.js';

/** One native boundary admits at most one independent source-backed context. */
export class LiveBoundaryContexts {
  private recovery?: LiveRecoveryHost;
  private pendingMeeting?: LiveMeetingHost;
  private meeting?: LiveMeetingHost;
  private pageActions?: LivePageActionAuthority;
  private callbackInvocationId?: string;
  private userSpeaking = false;
  private committedVoice = false;
  private closed = false;
  private realtimeSessionId?: string;
  private readonly pageResults: LivePageResultHost;
  readonly ownerVoice: LiveOwnerVoiceContext;

  constructor(
    private readonly options: LiveCompanionCallOptions,
    private readonly context: LiveContextGate,
    private readonly wakeNative: () => void,
    private readonly isSameCallExposure: (message: StoredMessage) => boolean,
    private readonly runAction?: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {
    this.pageResults = new LivePageResultHost(context, wakeNative, () => !this.closed && !this.userSpeaking);
    this.ownerVoice = new LiveOwnerVoiceContext(
      context,
      options.messageStore,
      () => ownerVoiceScope(context, this.callbackInvocationId, options.binding),
      isSameCallExposure,
      () => !this.closed && !this.userSpeaking,
      wakeNative,
    );
  }

  queuePageResult(notice: LivePageResultNotice): void {
    this.pageResults.queue(notice);
  }

  hasPendingPageResultWake(): boolean {
    return this.pageResults.hasPendingWake();
  }

  configure(callbackEnv: Record<string, string>): void {
    const input = {
      options: this.options,
      context: this.context,
      callbackEnv,
      wakeNative: this.wakeNative,
      isSameCallExposure: this.isSameCallExposure,
    };
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
        isAcceptedDirectVoice: (message) => this.isSameCallExposure(message),
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

  noteAcceptedDirectRequest(messageId: string, epoch: number): void {
    this.pageActions?.noteAcceptedDirectRequest(messageId, epoch);
  }

  noteOwnerVoice(message: StoredMessage, actionEpoch: number | undefined, voiceEpoch: number): void {
    if (actionEpoch !== undefined) this.noteAcceptedDirectRequest(message.id, actionEpoch);
    this.ownerVoice.queue(message, voiceEpoch);
  }

  async drainPageAction(): Promise<void> {
    await this.pageActions?.drain();
  }

  observeCall(): F317LiveCallObservation | null {
    if (this.closed) return null;
    const binding = this.options.binding;
    const scope = ownerVoiceScope(this.context, this.callbackInvocationId, binding);
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

  hasPendingWake(): boolean {
    return Boolean(
      this.pageResults.hasPendingWake() ||
        this.ownerVoice.hasPendingWake() ||
        this.meeting?.hasPendingWake() ||
        this.recovery?.hasPendingWake(),
    );
  }

  async atBoundary(_kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<void> {
    try {
      const voice = await this.ownerVoice.atBoundary();
      if (voice !== 'idle') {
        if (voice !== 'busy') this.pageResults.signal();
        return;
      }
      const pageResult = await this.pageResults.atBoundary();
      if (pageResult !== 'idle') return;
      const meeting = await this.meeting?.atBoundary();
      if (meeting === 'accepted' || meeting === 'busy') return;
      await this.recovery?.atBoundary();
    } catch (error) {
      this.options.reportInboxFailure?.(error);
    }
  }

  observe(message: CodexAppServerJsonObject): number | undefined {
    const params = message.params as Record<string, unknown> | undefined;
    const turn = params?.turn as Record<string, unknown> | undefined;
    this.ownerVoice.observeTurn(message.method, turn?.id);
    if (message.method === 'thread/realtime/started' && typeof params?.realtimeSessionId === 'string')
      this.realtimeSessionId = params.realtimeSessionId;
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
      this.committedVoice = false;
      this.ownerVoice.beginSpeech();
      this.pageActions?.interrupt();
      this.meeting?.onUserSpeaking();
      this.recovery?.cancel('user_speaking');
    }
    const item = params?.item as Record<string, unknown> | undefined;
    if (
      message.method === 'thread/realtime/item/completed' &&
      item?.type === 'transcriptSegment' &&
      item.role === 'user'
    ) {
      this.committedVoice = true;
      if (item.realtimeSessionId === this.realtimeSessionId && typeof item.id === 'string')
        this.ownerVoice.committed(item.id);
      // Capture the epoch before persistence; a later interruption cannot accept this delayed source.
      return this.pageActions?.interrupt();
    }
    if (message.method === 'thread/realtime/transcript/done' && params?.role === 'user') {
      this.userSpeaking = false;
      this.ownerVoice.finishSpeech(params?.text);
      if (!this.committedVoice) this.pageActions?.interrupt();
      this.committedVoice = false;
      this.onUserTurn();
    }
  }

  onUserTurn(): void {
    this.ownerVoice.signal();
    this.pageResults.signal();
    this.meeting?.onUserTurn();
    this.recovery?.onUserTurn();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ownerVoice.close();
    this.pageResults.close();
    this.pageActions?.close();
    const ledger = this.options.pageAction?.approvalLedger;
    if (ledger instanceof LivePageActionApprovalLedger) ledger.close();
    this.pendingMeeting?.close();
    this.pendingMeeting = undefined;
    this.meeting?.close();
    this.meeting = undefined;
    this.recovery?.close();
  }
}
