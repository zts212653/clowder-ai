import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { CodexLiveNativeClient, CodexLiveRunPort } from '../../cats/services/agents/providers/CodexLiveRunPort.js';
import type { FreshnessReadableMessage } from '../../cats/services/freshness/checkFreshnessForPostMessage.js';
import { LiveBoundaryContexts } from './host/live-boundary-contexts.js';
import { LiveContextGate, type LiveContextScope, type LiveControlledContext } from './host/live-controlled-context.js';
import { startLiveRealtime } from './host/live-realtime-start.js';
import { type LiveScreenAction, shareLiveScreen } from './host/live-screen-actions.js';
import { LiveSurfaceLease } from './host/live-surface-lease.js';
import { sendLiveText } from './host/live-text-delivery.js';
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
import { LiveNativeActivity } from './live-native-activity.js';
import { LiveNativeCredentials } from './live-native-credentials.js';
import { LiveNativeWork } from './live-native-work.js';
import { LiveSharedScreen } from './live-shared-screen.js';
import { liveMessageDigest, persistLiveTranscriptItem } from './live-transcript.js';

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
  private stopRequested = false;
  private readonly context: LiveContextGate;
  readonly boundaryContexts: LiveBoundaryContexts;
  private readonly surfaceLease = new LiveSurfaceLease(() => void this.fail(new Error('Live desktop lease expired')));
  private state: LiveCallState = 'preparing';
  private failureCode?: 'native_session_conflict';
  private constructor(
    private readonly options: LiveCompanionCallOptions,
    private readonly credentials: LiveNativeCredentials,
  ) {
    this.id = options.binding.callId;
    this.nativeWork = new LiveNativeWork(this.id);
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
    if (!this.stopRequested) this.surfaceLease.touch();
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
  acceptsInput(): boolean {
    return !this.stopRequested && this.state === 'talking';
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
  acceptsFreshness(): boolean {
    return this.acceptsInput() && this.options.householdToolsEnabled !== false;
  }
  exposureReason(message: FreshnessReadableMessage): 'same_live_call_exposure' | null {
    const state = {
      stopRequested: this.stopRequested,
      nativeThreadId: this.nativeThreadId,
      realtimeSessionId: this.realtimeSessionId,
    };
    return liveCallExposureReason(message, this.options.binding, state, this.exposedMessages.get(message.id));
  }
  isActiveCarrier(query: { invocationId: string; catId: string; threadId: string }): boolean {
    const active = this.client && this.nativeThreadId;
    return !this.stopRequested && Boolean(active) && this.credentials.matchesInvocation(query);
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
  signalInbox(): void {
    this.boundaryContexts.signalInbox();
  }
  hasPendingInboxWake(): boolean {
    return this.boundaryContexts.hasPendingWake();
  }
  async onSafeBoundary(kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<void> {
    await this.boundaryContexts.atBoundary(kind);
  }
  shareScreen(action: LiveScreenAction): void {
    shareLiveScreen(this.screen, action, this.state === 'talking' && !this.stopRequested);
  }
  async ready(nativeThreadId: string, client: CodexLiveNativeClient): Promise<void> {
    if (this.state !== 'preparing' || !(await this.options.verifyNativeBinding(nativeThreadId)))
      throw new Error('Live native binding unavailable');
    if (this.stopRequested) throw new Error('Live call ended during admission');
    this.nativeThreadId = nativeThreadId;
    this.client = client;
    this.state = 'ready';
    if (this.boundaryContexts.hasPendingWake()) client.wakeBoundary?.();
    this.initialized.resolve();
  }
  async start(offer: string): Promise<string> {
    this.touchSurface();
    await bounded(this.initialized.promise, 60_000);
    if (this.state !== 'ready' || !this.client || !this.nativeThreadId) throw new Error('Live call is not ready');
    this.state = 'connecting';
    try {
      const conversation = this.options.loadConversation ? await bounded(this.options.loadConversation()) : '';
      if (this.stopRequested) throw new Error('Live call ended during context loading');
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
      if (this.stopRequested) throw new Error('Live call ended during connection');
      this.state = 'talking';
      if (this.boundaryContexts.hasPendingWake()) this.client.wakeBoundary?.();
      return answer;
    } catch (error) {
      await this.fail(error instanceof Error ? error : new Error('Live start failed'));
      throw error;
    }
  }
  async sendText(
    text: string,
    clientMessageId: string,
  ): Promise<{ messageId: string; delivery: 'accepted' | 'unconfirmed' }> {
    const actionEpoch = text.trim() ? this.boundaryContexts.interruptPageAction() : undefined;
    const delivery = await sendLiveText({
      options: this.options,
      client: this.client,
      nativeThreadId: this.nativeThreadId,
      isAvailable: () => this.acceptsInput(),
      text,
      clientMessageId,
      deliveries: this.textDeliveries,
      exposedMessages: this.exposedMessages,
    });
    if (delivery.delivery === 'accepted' && delivery.newlyPersisted && actionEpoch !== undefined)
      this.boundaryContexts.noteAcceptedDirectText(delivery.messageId, actionEpoch);
    if (delivery.delivery === 'accepted') this.boundaryContexts.onUserTurn();
    return { messageId: delivery.messageId, delivery: delivery.delivery };
  }
  async observe(message: CodexAppServerJsonObject): Promise<void> {
    const params = record(message.params);
    const turn = record(params.turn);
    const native = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!native || (this.nativeThreadId && native !== this.nativeThreadId)) return;
    if (this.nativeThreadId === native) this.boundaryContexts.observe(message);
    if (!this.nativeWork.observe(message, this.stopping && this.state !== 'failed' ? this.activeTurnId : undefined))
      return;
    if (message.method === 'turn/started' && typeof turn.id === 'string') {
      this.nativeThreadId = native;
      this.activeTurnId = turn.id;
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
    const item = record(params.item);
    if (
      message.method === 'item/completed' &&
      params.turnId === this.activeTurnId &&
      item.type === 'mcpToolCall' &&
      item.server === 'cat-cafe-memory' &&
      item.status === 'completed' &&
      !item.error &&
      record(item.result).isError !== true
    )
      this.toolsReady = true;
    if (!this.startingRealtime) return;
    if (message.method === 'thread/realtime/started' && typeof params.realtimeSessionId === 'string') {
      if (this.realtimeSessionId && params.realtimeSessionId !== this.realtimeSessionId)
        throw new Error('Live realtime identity changed');
      this.realtimeSessionId = params.realtimeSessionId;
    }
    if (message.method === 'thread/realtime/sdp' && typeof params.sdp === 'string') this.answer.resolve(params.sdp);
    if (this.realtimeSessionId) {
      const stored = await persistLiveTranscriptItem(
        this.options.messageStore,
        {
          ...this.options.binding,
          nativeThreadId: native,
          realtimeSessionId: this.realtimeSessionId,
          ...(this.activeTurnId ? { nativeTurnId: this.activeTurnId } : {}),
        },
        message,
        this.options.identitySnapshot,
      );
      if (stored) {
        this.exposedMessages.set(stored.id, {
          kind: stored.extra?.liveCompanion?.modality === 'voice' ? 'voice' : 'text',
          digest: liveMessageDigest(stored),
        });
        this.options.publish(stored);
      }
    }
    if (
      message.method === 'thread/realtime/error' ||
      (message.method === 'thread/realtime/closed' && !this.stopRequested)
    ) {
      await this.fail(new Error('Live transport closed'));
    }
  }
  stop(): Promise<void> {
    this.stopRequested = true;
    this.boundaryContexts.close();
    this.context.close('stopped');
    this.nativeActivity.clear();
    this.nativeWork.close();
    this.carrierOperations.close();
    this.screen?.stop();
    this.surfaceLease.close();
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
    this.state = 'failed';
    this.failureCode = liveFailureCode(error);
    this.stopRequested = true;
    this.boundaryContexts.close();
    this.context.close('failed');
    this.nativeActivity.clear();
    this.nativeWork.close();
    this.carrierOperations.close();
    this.screen?.stop();
    this.surfaceLease.close();
    await this.credentials.close();
    await this.screen?.close();
    await this.carrierOperations.drain();
    await this.boundaryContexts.drainPageAction();
    this.initialized.reject(error);
    this.answer.reject(error);
    this.finishedState.reject(error);
  }
}
