import type { CallbackPrincipal } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import {
  HomeActionController,
  type HomeActionRequest,
  type HomeActionResult,
} from '../../../action/HomeActionController.js';
import { type createJevPageSelector, ownerLiteralValues } from '../../../action/jev/JevPageSelector.js';
import type { LiveCompanionCall } from '../../LiveCompanionCall.js';
import type { LiveCompanionSessions } from '../../LiveCompanionSessions.js';
import type { LiveContextScope } from '../live-controlled-context.js';
import { HomeHubDelivery, type HomeHubEmitter } from './home-hub-delivery.js';
import { type HomeOwnedTarget, homeComposerLiteralValues } from './home-hub-targets.js';
import { HomePageSelection } from './home-page-selection.js';
import { executeHomeWork, type HomeWorkActionPort, type HomeWorkTarget, homeWorkTargets } from './home-work-action.js';
import { readLiveHomeRequest } from './live-home-request.js';

type Principal = Extract<CallbackPrincipal, { kind: 'invocation' }>;
type Current = HomeActionRequest & { scope: LiveContextScope };
interface Entry {
  call: LiveCompanionCall;
  controller: HomeActionController;
  current?: Current;
  targets: readonly (HomeOwnedTarget | HomeWorkTarget)[];
}

/** Adapt existing owner ports to a current source-backed Jev choice; never execute model-supplied coordinates. */
export class OwnerHomeActionService {
  private readonly entries = new Map<string, Entry>();
  readonly hub: HomeHubDelivery;
  constructor(
    private readonly deps: {
      ownerUserId: string;
      sessions: LiveCompanionSessions;
      messages: Pick<
        IMessageStore,
        'getOwnerComposerDraft' | 'putOwnerComposerDraft' | 'getById' | 'getByThread' | 'getByThreadAfter'
      >;
      isCurrentThread(userId: string, threadId: string): Promise<boolean>;
      threads: Pick<IThreadStore, 'list'>;
      emitter: HomeHubEmitter;
      selector?: ReturnType<typeof createJevPageSelector>;
      work?: HomeWorkActionPort;
      record(scope: LiveContextScope, result: HomeActionResult): Promise<void>;
    },
  ) {
    this.hub = new HomeHubDelivery({ ...deps, isCurrent: (request) => this.isCurrent(request) });
  }

  private async isCurrent(request: HomeActionRequest): Promise<boolean> {
    const entry = this.entries.get(request.callId);
    if (!entry?.current || request.signal.aborted) return false;
    const current = await this.currentRequest(entry.call, entry.current.scope);
    return Boolean(
      current &&
        current.messageId === request.messageId &&
        current.revision === request.revision &&
        !request.signal.aborted,
    );
  }

  private currentRequest(
    call: LiveCompanionCall,
    principal: Pick<LiveContextScope, 'invocationId' | 'catId' | 'threadId'>,
  ) {
    return readLiveHomeRequest({
      messages: this.deps.messages,
      currentScope: () => call.contextScope(principal),
      isCurrentThread: this.deps.isCurrentThread,
      authorize: () => call.hasCurrentCompanion(),
      voice: call.boundaryContexts.ownerVoice,
      available: () => call.householdToolsEnabled && call.boundaryContexts.ownerVoice.availableForAction(),
      exposed: (message) => call.exposureReason(message) !== null,
    });
  }

  async run(principal: Principal): Promise<HomeActionResult | null> {
    if (principal.userId !== this.deps.ownerUserId) throw new Error('Current owner Live call required');
    const observed = await this.deps.sessions.observeCall(principal.userId);
    const call = observed && this.deps.sessions.get(observed.callId, principal.userId);
    if (!call || !call.householdToolsEnabled || !call.contextScope(principal))
      throw new Error('Current owner Live call required');
    if (!this.deps.selector) return null;
    let entry = this.entries.get(call.id);
    if (!entry) {
      entry = this.createEntry(call, principal);
      this.entries.set(call.id, entry);
      void call.finished
        .finally(() => {
          entry?.controller.close();
          this.entries.delete(call.id);
        })
        .catch(() => {});
    }
    return entry.controller.run();
  }

  private createEntry(call: LiveCompanionCall, principal: Principal): Entry {
    let entry: Entry;
    const scopes = new WeakMap<HomeActionRequest, LiveContextScope>();
    const selector = this.deps.selector;
    if (!selector) throw new Error('Home selector unavailable');
    const pages = new HomePageSelection(this.hub.pages, selector);
    const selections = new WeakMap<HomeActionRequest, NonNullable<HomeActionResult['jev']>>();
    const controller = new HomeActionController({
      currentRequest: async () => {
        const current = await this.currentRequest(call, principal);
        entry.current = current ?? undefined;
        if (current) scopes.set(current, current.scope);
        return current;
      },
      targets: async (request) => {
        const assertCurrent = async () => {
          if (!(await this.isCurrent(request))) throw new Error('Home request changed');
        };
        const selection = await pages.resolve(request, assertCurrent);
        if (!('page' in selection)) {
          entry.targets = [];
          return selection;
        }
        const scope = scopes.get(request);
        const home = await this.hub.targets(request, selection.page);
        const work = this.deps.work && scope ? homeWorkTargets(await this.deps.work.read(scope, assertCurrent)) : [];
        await assertCurrent();
        entry.targets = [...work, ...home.slice(0, 32 - work.length)];
        return entry.targets;
      },
      select: async (request, targets) => {
        const selector = this.deps.selector;
        if (!selector) return { kind: 'none', reason: 'Jev unavailable' };
        const standard = ownerLiteralValues(request.text);
        const selected = await selector.select({
          utterance: request.text,
          candidates: targets.map((t) => ({ ...t, fingerprint: t.revision })),
          literalValues: standard.length ? standard : homeComposerLiteralValues(request.text),
          signal: request.signal,
        });
        const { requestId, servedModel, inputSha256, elapsedMs } = selected.receipt;
        selections.set(request, { requestId, servedModel, inputSha256, elapsedMs });
        return selected.choice;
      },
      execute: async (request, target, choice) => {
        const owned = entry.targets.find(
          (candidate) => candidate.id === target.id && candidate.revision === target.revision,
        );
        if (!owned) return { status: 'stale' };
        if ('publication' in owned) {
          const scope = scopes.get(request);
          if (!scope || !this.deps.work) return { status: 'stale' };
          const assertCurrent = async () => {
            if (!(await this.isCurrent(request))) throw new Error('Home request changed');
          };
          const selection = await pages.resolve(request, assertCurrent);
          if (!('page' in selection)) return selection;
          return executeHomeWork(this.hub, this.deps.work, scope, request, owned, assertCurrent, selection.page);
        }
        return this.hub.execute(request, owned, choice);
      },
      record: async (request, result) => {
        const scope = scopes.get(request);
        if (!scope || scope.callId !== request.callId) throw new Error('Home result scope unavailable');
        await this.deps.record(scope, result);
      },
      selectionReceipt: (request) => selections.get(request),
    });
    entry = { call, targets: [], controller };
    return entry;
  }

  close(): void {
    this.hub.close();
    for (const entry of this.entries.values()) entry.controller.close();
    this.entries.clear();
  }
}
