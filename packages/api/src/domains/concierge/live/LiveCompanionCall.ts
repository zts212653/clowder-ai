import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { CodexLiveNativeClient, CodexLiveRunPort } from '../../cats/services/agents/providers/CodexLiveRunPort.js';
import { CodexLiveStartupCancelledError } from '../../cats/services/agents/providers/CodexLiveRunPort.js';
import type { CodexSubexecutionEvent } from '../../cats/services/agents/providers/CodexSubexecutionIdentity.js';
import type { FreshnessReadableMessage } from '../../cats/services/freshness/freshness-unseen-source.js';
import type {
  HostTextSubmission,
  HostVoiceObservation,
} from '../../plugin/desktop-window-runtime/companion-private-wire.js';
import { LiveBoundaryContexts } from './host/live-boundary-contexts.js';
import { recordCallTranscript } from './host/live-call-transcript.js';
import { LiveContextGate, type LiveContextScope, type LiveControlledContext } from './host/live-controlled-context.js';
import { LiveLateResultNotices } from './host/live-late-result-notices.js';
import { startLiveRealtime } from './host/live-realtime-start.js';
import { LiveResultReturn } from './host/live-result-return.js';
import { type LiveScreenAction, shareLiveScreen } from './host/live-screen-actions.js';
import { LiveSurfaceLease } from './host/live-surface-lease.js';
import { type LiveTextDelivery, sendLiveCallText } from './host/live-text-delivery.js';
import { stopLiveNative } from './host/stop-live-native.js';
import {
  LiveCarrierOperationGate,
  type LiveCarrierOperationLease,
  LiveCarrierUnavailableError,
} from './LiveCarrierOperationGate.js';
import { bounded, deferred, record } from './live-call-async.js';
import type { LiveCompanionCallOptions } from './live-call-options.js';
import { type LiveCallState, liveCallStatus, liveFailureCode } from './live-call-status.js';
import { liveCompositionInstructions } from './live-companion-selection.js';
import { liveCallExposureReason } from './live-exposure.js';
import { buildLiveMcpConfig } from './live-mcp-config.js';
import { LiveNativeActivity, liveNativeToolsReady } from './live-native-activity.js';
import { LiveNativeCredentials } from './live-native-credentials.js';
import { LiveNativeWork } from './live-native-work.js';
import {
  type LivePresentationObservation,
  LivePresentationObservations,
  type LivePresentationReply,
} from './live-presentation-observations.js';
import { LiveResponseTrace } from './live-response-trace.js';
import { LiveSharedScreen } from './live-shared-screen.js';
import { LiveSubexecutionLog } from './live-subexecution-log.js';

export type { LiveCompanionCallOptions } from './live-call-options.js';
export class LiveCompanionCall implements CodexLiveRunPort {
  readonly id: string;
  readonly initialized = deferred<void>();
  readonly finishedState = deferred<void>();
  readonly finished = this.finishedState.promise;
  readonly answer = deferred<string>();
  private readonly idleWaiters = new Set<() => void>();
  private client?: CodexLiveNativeClient;
  private nativeThreadId?: string;
  private realtimeSessionId?: string;
  private activeTurnId?: string;
  private screen?: LiveSharedScreen;
  private toolsReady = false;
  private readonly textDeliveries = new Map<string, Promise<{ messageId: string; delivery: 'accepted' }>>();
  private readonly exposedMessages = new Map<string, { kind: 'text' | 'voice'; digest: string }>();
  private startingRealtime = false;
  private stopping?: Promise<void>;
  private readonly carrierOperations = new LiveCarrierOperationGate();
  private readonly nativeActivity = new LiveNativeActivity();
  private readonly nativeWork: LiveNativeWork;
  private readonly resultReturn: LiveResultReturn;
  private readonly subexecutionLog: LiveSubexecutionLog;
  private readonly responseTrace: LiveResponseTrace;
  private readonly presentation: LivePresentationObservations;
  private readonly lateResults: LiveLateResultNotices;
  private readonly startupController = new AbortController();
  readonly startupSignal: AbortSignal = this.startupController.signal;
  private readonly context: LiveContextGate;
  readonly boundaryContexts: LiveBoundaryContexts;
  readonly hasPendingPageResultWake = () => this.boundaryContexts.hasPendingPageResultWake();
  readonly hasPendingOwnerVoiceWake = () => this.boundaryContexts.ownerVoice.hasPendingWake();
  private readonly surfaceLease = new LiveSurfaceLease(() => void this.fail(new Error('Live desktop lease expired')));
  private state: LiveCallState = 'preparing';
  private failureCode?: 'native_session_conflict';
  private constructor(
    private readonly options: LiveCompanionCallOptions,
    private readonly credentials: LiveNativeCredentials,
  ) {
    this.id = options.binding.callId;
    this.responseTrace = new LiveResponseTrace(options.binding);
    this.presentation = new LivePresentationObservations({
      scope: options.binding,
      store: options.messageStore,
      session: () => this.realtimeSessionId,
      available: () => this.acceptsInput(),
      verify: () => this.hasCurrentCompanion(),
      observed: (receipt, nativeItemId) =>
        this.responseTrace.mark('first_text_visible', { nativeItemId }, receipt.observedAt),
    });
    this.nativeWork = new LiveNativeWork(this.id);
    this.subexecutionLog = new LiveSubexecutionLog({
      scope: options.binding,
      rootThread: () => this.nativeThreadId,
      available: () => !this.startupSignal.aborted && ['ready', 'connecting', 'talking'].includes(this.state),
      verify: () => this.hasCurrentCompanion(),
      store: options.messageStore,
      publish: options.publish,
      recorded: (event, message) => this.responseTrace.child(event, message.id),
    });
    this.lateResults = new LiveLateResultNotices({
      scope: options.binding,
      store: options.messageStore,
      available: () => this.acceptsInput() && this.householdToolsEnabled,
      epoch: () => this.resultReturn.currentEpoch(),
      verify: () => this.hasCurrentCompanion(),
      client: () => this.client,
      run: (operation) => this.carrierOperations.run(operation),
      publish: options.publish,
    });
    this.resultReturn = new LiveResultReturn({
      client: () => this.client,
      threadId: () => this.nativeThreadId,
      realtimeSessionId: () => this.realtimeSessionId,
      available: () => this.acceptsInput(),
      verifyCompanion: () => this.hasCurrentCompanion(),
      handed: (turnId, itemId) => {
        this.nativeWork.resultHandedToVoice(turnId, itemId, this.options.binding.catId);
        this.responseTrace.mark('speech_submitted', { nativeTurnId: turnId, nativeItemId: itemId });
      },
      acceptedInput: (turnId, refs) => {
        this.subexecutionLog.acceptedInput(turnId, refs);
        this.responseTrace.mark('native_accepted', { nativeTurnId: turnId, sourceRefs: refs });
      },
      defer: (turnId, itemId, refs) =>
        this.lateResults.defer(turnId, itemId, refs).catch((error) => this.options.reportInboxFailure?.(error)),
    });
    this.context = new LiveContextGate({
      binding: options.binding,
      acceptsInput: () => this.acceptsInput(),
      matchesInvocation: (query) => this.credentials.matchesInvocation(query),
      householdToolsEnabled: () => options.householdToolsEnabled !== false,
      verifyCompanion: () => this.hasCurrentCompanion(),
      client: () => this.client,
      run: (operation) => this.carrierOperations.run(operation),
    });
    this.boundaryContexts = new LiveBoundaryContexts(
      options,
      this.context,
      () => this.client?.wakeBoundary?.(),
      (message) => this.exposureReason(message) !== null,
      (operation) => this.carrierOperations.run(operation),
    );
    this.touchSurface();
  }
  touchSurface(): void {
    if (!this.startupSignal.aborted) this.surfaceLease.touch();
  }
  static async create(options: LiveCompanionCallOptions): Promise<LiveCompanionCall> {
    const call = new LiveCompanionCall(options, await LiveNativeCredentials.create(options.binding));
    try {
      if (options.desktopRoot)
        call.screen = await LiveSharedScreen.create(options.desktopRoot, (meta) =>
          call.credentials.matchesNative(meta),
        );
      return call;
    } catch (error) {
      await call.fail(error instanceof Error ? error : new Error('Screen initialization failed'));
      throw error;
    }
  }
  status() {
    return {
      ...liveCallStatus(this.options, this.state, this.toolsReady, this.nativeActivity.state, Boolean(this.screen)),
      nativeWork: this.nativeWork.snapshot(),
      ...(this.failureCode ? { failureCode: this.failureCode } : {}),
    };
  }
  transcriptScope(): { callId: string; realtimeSessionId: string } | undefined {
    return this.realtimeSessionId ? { callId: this.id, realtimeSessionId: this.realtimeSessionId } : undefined;
  }
  acceptsAdmission(): boolean {
    return !this.startupSignal.aborted && this.state === 'preparing';
  }
  acceptsInput(): boolean {
    return !this.startupSignal.aborted && this.state === 'talking';
  }
  get householdToolsEnabled(): boolean {
    return this.options.householdToolsEnabled !== false;
  }
  get compositionInstructions(): string | undefined {
    return this.options.companion ? liveCompositionInstructions(this.options.companion) : undefined;
  }
  async hasCurrentCompanion(): Promise<boolean> {
    return this.options.verifyCompanion ? this.options.verifyCompanion() : true;
  }
  exposureReason(message: FreshnessReadableMessage): 'same_live_call_exposure' | null {
    const state = {
      stopRequested: this.startupSignal.aborted,
      nativeThreadId: this.nativeThreadId,
      realtimeSessionId: this.realtimeSessionId,
    };
    return liveCallExposureReason(message, this.options.binding, state, this.exposedMessages.get(message.id));
  }
  isActiveCarrier(query: { invocationId: string; catId: string; threadId: string }): boolean {
    const active = this.client && this.nativeThreadId;
    return !this.startupSignal.aborted && Boolean(active) && this.credentials.matchesInvocation(query);
  }
  contextScope(query: { invocationId: string; catId: string; threadId: string }): LiveContextScope | null {
    return this.context.scope(query);
  }
  injectControlledContext(input: LiveControlledContext): Promise<'accepted'> {
    return this.context.inject(input);
  }
  withCarrierOperation<T>(
    query: { invocationId: string; catId: string; threadId: string },
    operation: (lease: LiveCarrierOperationLease) => Promise<T>,
  ): Promise<T> {
    if (!this.isActiveCarrier(query)) return Promise.reject(new LiveCarrierUnavailableError());
    return this.carrierOperations.runForCarrier(query, operation);
  }
  async configure(callbackEnv: Record<string, string>) {
    const config = await buildLiveMcpConfig({
      credentials: this.credentials,
      callbackEnv,
      ...this.options,
      screenServer: this.screen?.server ?? this.options.screenServer,
    });
    this.boundaryContexts.configure(callbackEnv);
    return config;
  }
  hasPendingInboxWake(): boolean {
    return this.boundaryContexts.hasPendingWake() || this.lateResults.hasPending();
  }
  async onSafeBoundary(kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<void> {
    const contextsPending = this.boundaryContexts.hasPendingWake();
    await this.boundaryContexts.atBoundary(kind);
    if (!contextsPending && !this.resultReturn.ownerSpeaking() && kind !== 'tool_complete')
      await this.lateResults.atBoundary().catch((error) => this.options.reportInboxFailure?.(error));
  }
  shareScreen(action: LiveScreenAction): void {
    shareLiveScreen(this.screen, action, this.state === 'talking' && !this.startupSignal.aborted);
  }
  async ready(nativeThreadId: string, client: CodexLiveNativeClient): Promise<void> {
    if (this.state !== 'preparing') {
      const reason = this.startupSignal.reason;
      if (reason instanceof CodexLiveStartupCancelledError) throw reason;
      throw new Error('Live native binding unavailable');
    }
    this.startupSignal.throwIfAborted();
    const bound = await this.options.verifyNativeBinding(nativeThreadId);
    this.startupSignal.throwIfAborted();
    if (!bound) throw new Error('Live native binding unavailable');
    this.nativeThreadId = nativeThreadId;
    this.client = this.resultReturn.bind(client);
    this.boundaryContexts.ownerVoice.observeTurn('turn/started', this.activeTurnId);
    this.state = 'ready';
    if (this.boundaryContexts.hasPendingWake()) client.wakeBoundary?.();
    this.initialized.resolve();
    this.responseTrace.mark('native_ready');
  }
  async start(offer: string): Promise<string> {
    this.touchSurface();
    await bounded(this.initialized.promise, 60_000);
    if (this.state !== 'ready' || !this.client || !this.nativeThreadId) throw new Error('Live call is not ready');
    this.state = 'connecting';
    try {
      const conversation = this.options.loadConversation ? await bounded(this.options.loadConversation()) : '';
      if (this.startupSignal.aborted) throw new Error('Live call ended during context loading');
      this.startingRealtime = true;
      await bounded(
        startLiveRealtime({
          client: this.client,
          nativeThreadId: this.nativeThreadId,
          offer,
          conversation,
          catId: this.options.binding.catId,
          householdToolsEnabled: this.options.householdToolsEnabled,
          compositionInstructions: this.compositionInstructions,
        }),
        30_000,
      );
      const answer = await bounded(this.answer.promise, 30_000);
      if (this.startupSignal.aborted) throw new Error('Live call ended during connection');
      this.state = 'talking';
      await this.lateResults.recover().catch((error) => this.options.reportInboxFailure?.(error));
      await this.resultReturn.flushOpening((message, turnId) => this.recordTranscript(message, turnId));
      if (this.boundaryContexts.hasPendingWake()) this.client.wakeBoundary?.();
      return answer;
    } catch (error) {
      await this.fail(error instanceof Error ? error : new Error('Live start failed'));
      throw error;
    }
  }
  async sendText(text: string, clientMessageId: string): Promise<LiveTextDelivery> {
    this.responseTrace.mark('typed_received', { clientMessageId });
    return sendLiveCallText({
      options: this.options,
      client: this.client,
      nativeThreadId: this.nativeThreadId,
      isAvailable: () => this.acceptsInput(),
      text,
      clientMessageId,
      contexts: this.boundaryContexts,
      onNewOwnerText: () => this.resultReturn.ownerChanged(),
      onPersisted: (messageId) => this.responseTrace.mark('persistent_accept', { messageId, clientMessageId }),
      deliveries: this.textDeliveries,
      exposedMessages: this.exposedMessages,
    });
  }
  async observe(message: CodexAppServerJsonObject): Promise<void> {
    const params = record(message.params);
    const turn = record(params.turn);
    const native = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!native || (this.nativeThreadId && native !== this.nativeThreadId)) return;
    this.responseTrace.protocol(message, this.realtimeSessionId);
    const actionEpoch = this.nativeThreadId === native ? this.boundaryContexts.observe(message) : undefined;
    const voiceEpoch = this.boundaryContexts.ownerVoice.currentEpoch();
    if (!this.nativeWork.observe(message, this.stopping && this.state !== 'failed' ? this.activeTurnId : undefined))
      return;
    if (message.method === 'turn/started' && typeof turn.id === 'string') {
      this.nativeThreadId = native;
      this.activeTurnId = turn.id;
      this.subexecutionLog.rootStarted(native, turn.id);
      await this.credentials.started(native, turn.id);
    }
    if (message.method === 'turn/completed' && typeof turn.id === 'string') {
      await this.credentials.completed(turn.id);
      if (this.activeTurnId === turn.id) {
        this.activeTurnId = undefined;
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
    this.nativeActivity.observe(message, this.activeTurnId);
    this.resultReturn.observe(message, this.activeTurnId);
    if (liveNativeToolsReady(message, this.activeTurnId)) this.toolsReady = true;
    if (!this.startingRealtime) {
      await this.resultReturn.present(message, this.activeTurnId);
      return;
    }
    if (message.method === 'thread/realtime/started' && typeof params.realtimeSessionId === 'string') {
      if (this.realtimeSessionId && params.realtimeSessionId !== this.realtimeSessionId)
        throw new Error('Live realtime identity changed');
      this.realtimeSessionId = params.realtimeSessionId;
    }
    if (message.method === 'thread/realtime/sdp' && typeof params.sdp === 'string') this.answer.resolve(params.sdp);
    if (this.realtimeSessionId) {
      await this.recordTranscript(message, this.activeTurnId, actionEpoch, voiceEpoch);
      await this.resultReturn.present(message, this.activeTurnId);
    }
    if (
      message.method === 'thread/realtime/error' ||
      (message.method === 'thread/realtime/closed' && !this.startupSignal.aborted)
    ) {
      await this.fail(new Error('Live transport closed'));
    }
  }
  observeSubexecution(event: CodexSubexecutionEvent): Promise<void> {
    return this.subexecutionLog.observe(event);
  }
  observeHostAcquisition(mode: 'cold' | 'warm'): void {
    this.responseTrace.mark('host_acquired', { hostMode: mode });
  }
  async observeVoice(receipt: HostVoiceObservation): Promise<void> {
    if (
      !this.acceptsInput() ||
      receipt.callId !== this.id ||
      !(await this.hasCurrentCompanion()) ||
      !this.acceptsInput()
    )
      return;
    this.responseTrace.playback(receipt);
    this.presentation.outward(receipt);
  }
  observePresentation(
    receipt: LivePresentationObservation,
    verifyHost?: () => Promise<boolean>,
  ): Promise<LivePresentationReply> {
    return this.presentation.observe(receipt, verifyHost);
  }
  async observeTextSubmission(receipt: HostTextSubmission & { callId: string }): Promise<void> {
    if (
      receipt.callId !== this.id ||
      this.startupSignal.aborted ||
      !(await this.hasCurrentCompanion()) ||
      this.startupSignal.aborted
    )
      return;
    this.responseTrace.textSubmission(receipt);
  }
  private recordTranscript(
    message: CodexAppServerJsonObject,
    nativeTurnId?: string,
    actionEpoch?: number,
    voiceEpoch = this.boundaryContexts.ownerVoice.currentEpoch(),
  ): Promise<void> {
    return recordCallTranscript({
      options: this.options,
      nativeThreadId: this.nativeThreadId,
      realtimeSessionId: this.realtimeSessionId,
      nativeTurnId,
      envelope: message,
      returnProjection: this.resultReturn.projection(message, nativeTurnId),
      exposedMessages: this.exposedMessages,
      onOwnerVoice: (stored) => this.boundaryContexts.noteOwnerVoice(stored, actionEpoch, voiceEpoch),
      onCommitted: async (stored) => {
        const live = stored.extra?.liveCompanion;
        const native = live && live.modality !== 'typed' ? live : undefined;
        this.responseTrace.mark(stored.catId ? 'result_committed' : 'persistent_accept', {
          messageId: stored.id,
          nativeItemId: native?.nativeItemId,
          nativeTurnId: native?.nativeTurnId,
        });
        await this.lateResults.record(stored);
      },
      onPublished: (stored) => {
        if (stored.catId && stored.extra?.liveCompanion?.modality === 'result')
          this.responseTrace.mark('first_outward_text', {
            messageId: stored.id,
            nativeItemId: stored.extra.liveCompanion.nativeItemId,
            nativeTurnId: stored.extra.liveCompanion.nativeTurnId,
          });
      },
    });
  }
  private revokeCarrier(reason: 'stopped' | 'failed'): void {
    this.responseTrace.close();
    this.presentation.close();
    this.lateResults.close();
    this.subexecutionLog.close();
    this.resultReturn.close();
    this.boundaryContexts.close();
    this.context.close(reason);
    this.nativeActivity.clear();
    this.nativeWork.close();
    this.carrierOperations.close();
    this.screen?.stop();
    this.surfaceLease.close();
  }
  stop(): Promise<void> {
    this.startupController.abort(new CodexLiveStartupCancelledError());
    this.revokeCarrier('stopped');
    this.stopping ??= this.stopOwnedCall();
    return this.stopping;
  }
  private async stopOwnedCall(): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return;
    try {
      await this.credentials.close();
      await this.screen?.close();
      await stopLiveNative({
        client: this.client,
        nativeThreadId: this.nativeThreadId,
        startingRealtime: this.startingRealtime,
        activeTurnId: this.activeTurnId,
        idleWaiters: this.idleWaiters,
      });
      await this.carrierOperations.drain();
      await this.boundaryContexts.drainPageAction();
      this.state = 'closed';
      await this.credentials.close();
      this.initialized.reject(new Error('Live call ended'));
      this.answer.reject(new Error('Live call ended'));
      this.finishedState.resolve();
    } catch (error) {
      await this.fail(error instanceof Error ? error : new Error('Live stop failed'));
    }
  }
  async fail(error: Error): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.startupController.abort(error);
    this.state = 'failed';
    this.failureCode = liveFailureCode(error);
    this.revokeCarrier('failed');
    await this.credentials.close();
    await this.screen?.close();
    await this.carrierOperations.drain();
    await this.boundaryContexts.drainPageAction();
    this.initialized.reject(error);
    this.answer.reject(error);
    this.finishedState.reject(error);
  }
}
