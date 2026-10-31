import { type ConciergeConfig, catRegistry } from '@cat-cafe/shared';
import type { CompanionState } from '@clowder-ai/plugin-contract-beta21';
import { z } from 'zod';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import {
  type HostCompanionCommand as CompanionCommand,
  type HostCompanionReply as CompanionReply,
  type HostCompanionState,
  type HostNativeWork,
  type HostTextSubmission,
  type HostVoiceObservation,
  hostNativeWork,
  validateHostCompanionCommand as validateCompanionCommand,
  validateHostCompanionReply as validateCompanionReply,
} from '../../plugin/desktop-window-runtime/companion-private-wire.js';
import {
  type CompanionArchiveContract,
  isModernCompanionContract,
} from '../../plugin/desktop-window-runtime/published-companion-v2.js';
import { CompanionF221Trial } from './CompanionF221Trial.js';
import { readCompanionDecisions } from './companion-decision-read.js';
import { CompanionBridgeError, CompanionOwnerClient } from './companion-owner-client.js';
import type { DesktopAppAssistOwner } from './host/companion-app-assist-owner.js';
import { CompanionConversationHistory } from './host/companion-conversation-history.js';
import { readCompanionConversation } from './host/companion-conversation-read.js';
import { readModernCompanionTranscript, sendCompanionText } from './host/companion-modern-live.js';
import { readModernCompanionSettings, updateModernCompanionSettings } from './host/companion-modern-settings.js';
import { CompanionSubmissionDelivery } from './host/companion-submission-delivery.js';
import {
  type CompanionWorkPort,
  companionWorkNavigationFailure,
  readCompanionWorkPort,
} from './host/companion-work-port.js';
import {
  type CompanionDecisionDestination,
  CompanionUnifiedDecisions,
} from './host/unified/companion-unified-decisions.js';
import { LiveCompanionSelectionError, resolveLiveCompanionSelection } from './live-companion-selection.js';
import type { LivePresentationObservation, LivePresentationReply } from './live-presentation-observations.js';

type Options = ConstructorParameters<typeof CompanionOwnerClient>[0] & {
  /** Exact published archive admission from the installed package digest. */
  readonly publicCompanionV2: boolean;
  readonly companionContract?: CompanionArchiveContract['contract'];
  readonly messages?: IMessageStore;
  readonly verifyConversationThread?: (threadId: string) => Promise<boolean>;
  readonly work?: CompanionWorkPort;
  readonly disableCompanion?: () => Promise<void>;
  readonly appAssist?: DesktopAppAssistOwner;
  readonly openConversation: (threadId: string) => Promise<boolean>;
  readonly canOpenDecision?: (destination: CompanionDecisionDestination) => Promise<boolean>;
  readonly openDecision?: (destination: CompanionDecisionDestination) => Promise<boolean>;
  readonly observeVoice?: (observation: HostVoiceObservation) => Promise<void>;
  readonly observeTextSubmission?: (observation: HostTextSubmission & { callId: string }) => Promise<void>;
  readonly observePresentation?: (
    observation: LivePresentationObservation,
    verifyHost: () => Promise<boolean>,
  ) => Promise<LivePresentationReply>;
};
export class CompanionHostBridge {
  readonly appAssist?: DesktopAppAssistOwner;
  private readonly client: CompanionOwnerClient;
  private readonly f221: CompanionF221Trial;
  private readonly unified: CompanionUnifiedDecisions;
  private readonly history?: CompanionConversationHistory;
  private readonly submissions?: CompanionSubmissionDelivery;
  private callId: string | undefined;
  private pending: Promise<CompanionReply> | undefined;
  private changingDocuments = false;
  private generation = 0;
  private closed = false;
  constructor(private readonly options: Options) {
    this.appAssist = options.companionContract === '0.1.0-beta.29' ? options.appAssist : undefined;
    this.client = new CompanionOwnerClient({
      ...options,
      assertCurrent: () => this.assertCurrent(),
    });
    if (options.messages) {
      const historyOptions = {
        ownerUserId: options.ownerUserId,
        client: this.client,
        messages: options.messages,
        conversationThread: () => this.conversationThread(),
        assertCurrent: () => this.assertCurrent(),
        ...(options.verifyConversationThread ? { verifyThread: options.verifyConversationThread } : {}),
      };
      this.history = new CompanionConversationHistory(historyOptions);
      this.submissions = new CompanionSubmissionDelivery({ ...historyOptions, currentCallId: () => this.callId });
    }
    this.f221 = new CompanionF221Trial(this.client, options.ownerUserId, () => ({
      generation: this.generation,
      callId: this.callId,
    }));
    this.unified = new CompanionUnifiedDecisions({
      ...options,
      client: this.client,
      assertCurrent: () => this.assertCurrent(),
    });
  }

  private async assertCurrent(): Promise<void> {
    if (this.closed) throw new CompanionBridgeError('cancelled');
    try {
      await this.options.assertCurrent();
    } catch (error) {
      this.options.work?.reset();
      throw error;
    }
    if (this.closed) throw new CompanionBridgeError('cancelled');
  }
  async request(input: unknown): Promise<CompanionReply> {
    if (!validateCompanionCommand(input, this.options.companionContract))
      return { kind: 'error', code: 'invalid_request' };
    try {
      if (input.kind !== 'presentation.observe') await this.assertCurrent();
      const reply = await this.execute(input);
      if (
        input.kind !== 'presentation.observe' &&
        !(input.kind === 'companion.disable' && reply.kind === 'companion-lifecycle')
      )
        await this.assertCurrent();
      return validateCompanionReply(reply, this.options.companionContract)
        ? reply
        : { kind: 'error', code: 'unavailable' };
    } catch (error) {
      if (input.kind === 'work.open') return companionWorkNavigationFailure(error);
      return {
        kind: 'error',
        code:
          error instanceof CompanionBridgeError
            ? error.code
            : error instanceof LiveCompanionSelectionError
              ? 'carrier_unavailable'
              : 'unavailable',
      };
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.history?.close();
    this.unified.reset();
    this.options.work?.reset();
    await this.stop();
  }
  async observeVoice(observation: HostVoiceObservation): Promise<void> {
    await this.assertCurrent();
    if (observation.callId !== this.callId || !this.options.observeVoice) return;
    await this.options.observeVoice(observation);
  }
  async observeTextSubmission(observation: HostTextSubmission): Promise<void> {
    const current = this.callId;
    const generation = this.generation;
    if (!current || !this.options.observeTextSubmission) return;
    await this.assertCurrent();
    this.assertGeneration(generation);
    await this.options.observeTextSubmission({ ...observation, callId: current });
    this.assertGeneration(generation);
    await this.assertCurrent();
  }
  private async execute(command: CompanionCommand): Promise<CompanionReply> {
    switch (command.kind) {
      case 'settings.read':
        return readModernCompanionSettings(this.client, this.options.companionContract);
      case 'work.read':
        return readCompanionWorkPort(this.options.work);
      case 'work.open':
        return { kind: 'navigation', delivery: (await this.options.work?.open(command.entryRef)) ?? 'blocked' };
      case 'settings.update':
        return updateModernCompanionSettings(this.client, command, () => {
          ++this.generation;
          this.callId = undefined;
          this.f221.reset();
        });
      case 'companion.disable':
        if (!this.options.disableCompanion) throw new CompanionBridgeError('permission_required');
        await this.options.disableCompanion();
        return { kind: 'companion-lifecycle', action: 'disable', outcome: 'disabled' };
      case 'state':
        return this.state();
      case 'prepare':
        return this.prepare();
      case 'stop':
        await this.stop();
        return { kind: 'ok' };
      case 'documents':
        if (this.changingDocuments) throw new CompanionBridgeError('busy');
        this.changingDocuments = true;
        try {
          await this.stop();
          await this.client.request('/api/concierge/config', 'PUT', { householdReadsAllowed: command.allowed });
          return await this.state();
        } finally {
          this.changingDocuments = false;
        }
      case 'conversation.open': {
        const opened = await this.options.openConversation(await this.conversationThread());
        return { kind: 'navigation', delivery: opened ? 'requested' : 'unconfirmed' };
      }
      case 'decisions.read':
        return ['0.1.0-beta.24', '0.1.0-beta.25', '0.1.0-beta.27', '0.1.0-beta.28', '0.1.0-beta.29'].includes(
          this.options.companionContract ?? '',
        )
          ? this.unified.read(command.offset, command.limit)
          : readCompanionDecisions(this.client, command.offset, command.limit);
      case 'decision.open':
        return {
          kind: 'navigation',
          delivery: (await this.unified.open(command.variantRef, command.target)) ? 'requested' : 'unconfirmed',
        };
      case 'f221.inspect':
        return this.f221.inspect(command.proposalId);
      case 'f221.confirm-trial':
        return this.f221.confirm(command.nonce, command.action);
      case 'conversation.body.read':
        if (!this.history) throw new CompanionBridgeError('unavailable');
        return this.history.readBody(command.continuation);
      case 'conversation.draft.read':
        if (!this.submissions) throw new CompanionBridgeError('unavailable');
        return this.submissions.readDraft();
      case 'conversation.draft.save':
        if (!this.submissions) throw new CompanionBridgeError('unavailable');
        return this.submissions.saveDraft(command.scopeRef, command.expectedRevision, command.text);
      case 'conversation.delivery.read':
        if (!this.submissions) throw new CompanionBridgeError('unavailable');
        return this.submissions.readDelivery(command.scopeRef, command.clientMessageId);
      case 'conversation.read':
        if ('v' in command && command.v === 2) {
          if (!this.history) throw new CompanionBridgeError('unavailable');
          return this.history.readPage(command);
        }
        return readCompanionConversation({
          client: this.client,
          includeSavedIdentity: this.options.publicCompanionV2,
          conversationThread: () => this.conversationThread(),
        });
      case 'offer': {
        const generation = this.generation;
        const result = await this.client.request(`${this.callPath()}/start`, 'POST', { offer: command.sdp });
        this.assertGeneration(generation);
        if (typeof result.answer !== 'string') throw new CompanionBridgeError('unavailable');
        if (!this.callId) throw new CompanionBridgeError('cancelled');
        return { kind: 'answer', sdp: result.answer, callId: this.callId };
      }
      case 'transcript.read': {
        const current = this.callId;
        if (!current) throw new CompanionBridgeError('session_required');
        const generation = this.generation;
        const transcript = await readModernCompanionTranscript(this.client, current);
        this.assertGeneration(generation);
        return transcript;
      }
      case 'presentation.observe': {
        const current = this.callId;
        const generation = this.generation;
        if (!current || current !== command.callId) return { kind: 'error', code: 'invalid_request' };
        if (!this.options.observePresentation) return { kind: 'error', code: 'unavailable' };
        // The consumer repeats this guard after any asynchronous reference read,
        // before recording a fact. Checking only after its reply would be too late.
        const verifyHost = async () => {
          try {
            await this.assertCurrent();
          } catch {
            return false;
          }
          return !this.closed && this.callId === current && this.generation === generation;
        };
        if (!(await verifyHost())) return { kind: 'error', code: 'invalid_request' };
        return this.options.observePresentation(command, verifyHost);
      }
      case 'text':
        if ('v' in command && command.v === 2) {
          if (!this.submissions) throw new CompanionBridgeError('unavailable');
          if (!this.callId && (this.pending || this.changingDocuments)) throw new CompanionBridgeError('busy');
          return this.submissions.submit(command);
        }
        if (!this.callId && (this.pending || this.changingDocuments)) throw new CompanionBridgeError('busy');
        return sendCompanionText({
          client: this.client,
          text: command.text,
          clientMessageId: command.clientMessageId,
          ...(this.callId ? { callId: this.callId } : {}),
          modern: isModernCompanionContract(this.options.companionContract),
          conversationThread: () => this.conversationThread(),
        });
      case 'screen.open':
        await this.client.request(`${this.callPath()}/screen`, 'POST', {
          kind: 'open',
          selectionId: command.selectionId,
          label: command.label,
        });
        return { kind: 'ok' };
      case 'screen.frame':
        await this.client.request(`${this.callPath()}/screen`, 'POST', {
          kind: 'frame',
          selectionId: command.selectionId,
          frame: command.frame,
        });
        return { kind: 'ok' };
      case 'screen.close':
        if (this.callId) await this.client.request(`${this.callPath()}/screen`, 'POST', { kind: 'close' });
        return { kind: 'ok' };
      // These belong to the trusted window executor, never a Host effect endpoint.
      case 'screen.pick':
      case 'app-assist.settle':
      case 'view.resize':
      case 'view.layout':
      case 'view.drag':
      case 'view.hide':
      case 'view.reset':
        throw new CompanionBridgeError('invalid_request');
    }
  }
  private async conversationThread(): Promise<string> {
    const result = await this.client.request('/api/concierge/thread', 'POST');
    if (typeof result.threadId !== 'string') throw new CompanionBridgeError('unavailable');
    return result.threadId;
  }
  private async configSource(): Promise<{ config: ConciergeConfig; behaviorEnabled: boolean }> {
    const result = await this.client.request('/api/concierge/config?view=native');
    if (!result.config || typeof result.config !== 'object') throw new CompanionBridgeError('unavailable');
    const config = result.config as ConciergeConfig;
    if (!isModernCompanionContract(this.options.companionContract))
      return { config, behaviorEnabled: result.behaviorEnabled === true };
    const settings = await readModernCompanionSettings(this.client, this.options.companionContract);
    if (settings.kind === 'error') throw new CompanionBridgeError(settings.code);
    if (
      settings.kind !== 'settings' ||
      settings.status !== 'available' ||
      settings.selectedCompanionStatus !== 'available'
    )
      throw new CompanionBridgeError('carrier_unavailable');
    return {
      config: { ...config, ...settings.values },
      behaviorEnabled: result.behaviorEnabled === true && settings.values.behaviorEnabled,
    };
  }
  private async state(): Promise<HostCompanionState> {
    const { config, behaviorEnabled } = await this.configSource();
    const selection = resolveLiveCompanionSelection(config, Object.values(catRegistry.getAllConfigs()));
    let phase: CompanionState['phase'] = 'idle';
    let toolsReady = false;
    let nativeActivity: CompanionState['nativeActivity'] = 'none';
    let nativeWork: HostNativeWork = { scopeId: null, revision: 0, active: [], recent: [] };
    if (this.callId) {
      const observedCall = this.callId;
      try {
        const result = await this.client.request(this.callPath());
        if (result.state === 'failed' && result.failureCode === 'native_session_conflict') {
          if (this.callId === observedCall) this.callId = undefined;
          throw new CompanionBridgeError('busy');
        }
        phase = z.enum(['preparing', 'ready', 'connecting', 'talking', 'closed', 'failed']).parse(result.state);
        toolsReady = result.toolsReady === true;
        nativeActivity = z.enum(['none', 'reasoning', 'tool_running']).parse(result.nativeActivity);
        nativeWork = hostNativeWork.parse(result.nativeWork);
        if (result.catId !== selection.carrier.catId) throw new CompanionBridgeError('selection_changed');
        if ((phase === 'closed' || phase === 'failed') && this.callId === observedCall) this.callId = undefined;
      } catch (error) {
        if (!(error instanceof CompanionBridgeError) || !['session_required', 'selection_changed'].includes(error.code))
          throw error;
        if (this.callId === observedCall) this.callId = undefined;
        if (error.code === 'selection_changed') throw error;
        phase = 'closed';
      }
    }
    return {
      kind: 'state',
      phase,
      displayName: selection.displayName,
      skin: selection.skin,
      duty: selection.duty,
      carrier: selection.carrier,
      documentsAllowed: config.householdReadsAllowed !== false,
      behaviorEnabled,
      toolsReady,
      nativeActivity,
      nativeWork,
      liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
      ...(['0.1.0-beta.27', '0.1.0-beta.28', '0.1.0-beta.29'].includes(this.options.companionContract ?? '')
        ? { meeting: { kind: 'unconfirmed', sharing: false, paused: false, sourceLabel: null } as const }
        : {}),
    };
  }
  private prepare(): Promise<CompanionReply> {
    if (this.changingDocuments) return Promise.reject(new CompanionBridgeError('busy'));
    if (this.pending) return this.pending;
    if (this.callId) return Promise.reject(new CompanionBridgeError('busy'));
    const operation = this.initialize(++this.generation);
    this.pending = operation;
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined;
      })
      .catch(() => undefined);
    return operation;
  }
  private async initialize(generation: number): Promise<CompanionReply> {
    const { config } = await this.configSource();
    this.assertGeneration(generation);
    const prepared = await this.client.request('/api/concierge/live', 'POST', {
      allowHomeReads: config.householdReadsAllowed !== false,
      ...(isModernCompanionContract(this.options.companionContract)
        ? { expectedDutyCatProfileId: config.dutyCatProfileId }
        : {}),
    });
    const callId = z.string().uuid().parse(prepared.callId);
    try {
      this.assertGeneration(generation);
      this.callId = callId;
      const deadline = Date.now() + 60_000;
      let state = await this.state();
      while (state.phase === 'preparing' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        this.assertGeneration(generation);
        state = await this.state();
      }
      this.assertGeneration(generation);
      if (state.phase !== 'ready') throw new CompanionBridgeError('unavailable');
      return state;
    } catch (error) {
      // Cancel may arrive before POST returns its id. Close exactly this late
      // handle; neither the renderer nor a newer call can choose this cleanup target.
      if (this.callId === callId) this.callId = undefined;
      await this.client.closeCall(callId);
      throw error;
    }
  }
  private async stop(): Promise<void> {
    ++this.generation;
    this.f221.reset();
    const callId = this.callId;
    this.callId = undefined;
    try {
      if (callId) await this.client.closeCall(callId);
    } finally {
      await this.pending?.catch(() => undefined);
    }
  }
  private callPath(): string {
    if (!this.callId) throw new CompanionBridgeError('session_required');
    return `/api/concierge/live/${encodeURIComponent(this.callId)}`;
  }
  private assertGeneration(generation: number): void {
    if (this.closed || generation !== this.generation) throw new CompanionBridgeError('cancelled');
  }
}
