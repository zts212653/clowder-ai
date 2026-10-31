import { randomUUID } from 'node:crypto';
import type { MessageMediaPublicationSource } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import type { HomeActionRequest, HomeActionResult } from '../../../action/HomeActionController.js';
import { ownerLiteralValues } from '../../../action/jev/JevPageSelector.js';
import type { PageChoice } from '../../../action/PageActionLoop.js';
import { type HomeHubPage, HomeHubPages } from './home-hub-pages.js';
import { type HomeOwnedTarget, homeComposerLiteralValues, homeHubTargets } from './home-hub-targets.js';
import { appendHomeOwnerDraft } from './home-owner-draft.js';
import { HomeWindowCapabilities } from './home-window-capabilities.js';
import { deliverHomeWork } from './home-work-delivery.js';

export interface HomeHubEmitter {
  isConnected?(ownerUserId: string, socketId: string): boolean;
  emitWithAck(
    ownerUserId: string,
    event: string,
    data: unknown,
    timeoutMs: number,
    socketIds?: readonly string[],
  ): Promise<unknown[]>;
  emit(ownerUserId: string, event: string, data: unknown, socketIds?: readonly string[]): void;
}
type Outcome = Pick<HomeActionResult, 'status' | 'reason'>;
export interface HomeHubCommand {
  ownerUserId: string;
  clientId: string;
  clientToken: string;
  signal: AbortSignal;
  expiresAt: number;
  authorize(expectedRevision?: number): Promise<unknown>;
  consumed?: Promise<unknown>;
}

export interface HomeWorkPublication {
  source: MessageMediaPublicationSource;
  artifact?: { contentRef: string; ownerRevision: number };
}

function validHomeChoice(
  request: HomeActionRequest,
  target: HomeOwnedTarget,
  choice: Extract<PageChoice, { kind: 'act' }>,
): boolean {
  const standard = ownerLiteralValues(request.text);
  const values = standard.length ? standard : homeComposerLiteralValues(request.text);
  return (
    choice.targetId === target.id &&
    choice.operation === target.operation &&
    (choice.operation !== 'fill' || Boolean(choice.value && values.includes(choice.value)))
  );
}

/** Short-lived delivery capabilities only; thread, draft and persistent result owners remain authoritative. */
export class HomeHubDelivery {
  private readonly commands = new Map<string, HomeHubCommand>();
  private readonly clients: HomeWindowCapabilities;
  readonly pages: HomeHubPages;
  constructor(
    private readonly deps: {
      messages: Pick<IMessageStore, 'getOwnerComposerDraft' | 'putOwnerComposerDraft'>;
      threads: Pick<IThreadStore, 'list'>;
      emitter: HomeHubEmitter;
      isCurrent(request: HomeActionRequest): Promise<boolean>;
    },
  ) {
    this.clients = new HomeWindowCapabilities(deps.emitter.isConnected);
    this.pages = new HomeHubPages(deps.emitter, this.clients, deps.threads);
  }

  registerClient(ownerUserId: string, clientId: string, socketId?: string) {
    return this.clients.register(ownerUserId, clientId, socketId);
  }

  unregisterClient(ownerUserId: string, clientId: string, clientToken: string): boolean {
    return this.clients.unregister(ownerUserId, clientId, clientToken);
  }

  async targets(request: HomeActionRequest, selected?: Pick<HomeHubPage, 'id'>): Promise<HomeOwnedTarget[]> {
    const discovery = await this.pages.read(request.userId);
    if (!('pages' in discovery) || request.signal.aborted) return [];
    const pages = selected ? discovery.pages.filter((page) => page.id === selected.id) : discovery.pages;
    const threads = await this.deps.threads.list(request.userId);
    return pages.flatMap((page) => homeHubTargets(page.state, threads, request.text)).slice(0, 32);
  }

  async execute(
    request: HomeActionRequest,
    target: HomeOwnedTarget,
    choice: Extract<PageChoice, { kind: 'act' }>,
  ): Promise<Outcome> {
    if (!validHomeChoice(request, target, choice)) return { status: 'blocked', reason: 'choice_not_from_owner' };
    for (const [token, command] of this.commands) if (command.expiresAt <= Date.now()) this.commands.delete(token);
    if (this.commands.size >= 64 || request.signal.aborted || !(await this.deps.isCurrent(request)))
      return { status: 'stale', reason: 'home_source_unavailable' };
    const expiresAt = Date.now() + 10_000;
    const command: HomeHubCommand = {
      ownerUserId: request.userId,
      clientId: target.clientId,
      clientToken: target.clientToken,
      signal: request.signal,
      expiresAt,
      authorize: (revision) => this.authorize(request, target, choice, expiresAt, revision),
    };
    return this.deliver(command);
  }

  /** The work owner revalidates the exact source on consume; this port owns delivery only. */
  async openWork(
    ownerUserId: string,
    resolve: () => Promise<HomeWorkPublication | null>,
    assertCurrent: () => Promise<void>,
    signal: AbortSignal = new AbortController().signal,
    page?: HomeHubPage,
  ): Promise<'applied' | 'blocked' | 'unconfirmed'> {
    return deliverHomeWork({
      ownerUserId,
      resolve,
      assertCurrent,
      signal,
      page,
      pages: this.pages,
      deliver: (command, verify) => this.deliver(command, verify),
    });
  }

  private async deliver(
    command: HomeHubCommand,
    verifyApplied?: (receipt: Record<string, unknown>) => boolean,
  ): Promise<Outcome> {
    for (const [token, pending] of this.commands) if (pending.expiresAt <= Date.now()) this.commands.delete(token);
    if (this.commands.size >= 64) return { status: 'unconfirmed', reason: 'hub_delivery_capacity' };
    const token = randomUUID();
    this.commands.set(token, command);
    const cancel = () =>
      this.deps.emitter.emit(
        command.ownerUserId,
        'home:cancel',
        { token, clientId: command.clientId },
        this.clients.connections(command.ownerUserId, command.clientId),
      );
    command.signal.addEventListener('abort', cancel, { once: true });
    try {
      const values = await this.deps.emitter.emitWithAck(
        command.ownerUserId,
        'home:execute',
        { token, clientId: command.clientId, expiresAt: command.expiresAt },
        8_000,
        this.clients.connections(command.ownerUserId, command.clientId),
      );
      const receipt = values.find((value): value is Record<string, unknown> & { status: string; reason?: string } => {
        if (!value || typeof value !== 'object') return false;
        const v = value as Record<string, unknown>;
        return (
          v.token === token &&
          v.clientId === command.clientId &&
          v.clientToken === command.clientToken &&
          typeof v.clientToken === 'string' &&
          this.clients.owns(command.ownerUserId, command.clientId, v.clientToken) &&
          typeof v.status === 'string'
        );
      });
      if (!receipt || !command.consumed) return { status: 'unconfirmed', reason: 'no_matching_hub_receipt' };
      if (command.signal.aborted || command.expiresAt <= Date.now())
        return { status: 'unconfirmed', reason: 'hub_request_expired' };
      return this.confirmOutcome(command, await command.consumed, receipt, verifyApplied);
    } finally {
      cancel();
      this.commands.delete(token);
      command.signal.removeEventListener('abort', cancel);
    }
  }

  private confirmOutcome(
    command: HomeHubCommand,
    grant: unknown,
    receipt: Record<string, unknown> & { status: string; reason?: string },
    verifyApplied?: (receipt: Record<string, unknown>) => boolean,
  ): Outcome {
    // The commit may finish after the earlier transport check; a cancelled display cannot become applied.
    if (
      command.signal.aborted ||
      command.expiresAt <= Date.now() ||
      !this.clients.owns(command.ownerUserId, command.clientId, String(receipt.clientToken))
    )
      return { status: 'unconfirmed', reason: 'hub_view_changed_during_commit' };
    if (
      !grant ||
      typeof grant !== 'object' ||
      !('kind' in grant) ||
      !['navigate', 'updated'].includes(String(grant.kind))
    )
      return { status: 'blocked', reason: 'owner_action_not_authorized' };
    if (grant.kind === 'updated' && receipt.status !== 'applied')
      return { status: 'unconfirmed', reason: 'draft_committed_display_unconfirmed' };
    if (!['applied', 'blocked', 'unconfirmed'].includes(receipt.status)) return { status: 'unconfirmed' };
    if (receipt.status === 'applied' && verifyApplied && !verifyApplied(receipt))
      return { status: 'unconfirmed', reason: 'publication_display_not_confirmed' };
    return {
      status: receipt.status as Outcome['status'],
      ...(receipt.reason ? { reason: receipt.reason.slice(0, 160) } : {}),
    };
  }

  consume(
    ownerUserId: string,
    token: string,
    clientId: string,
    clientToken: string,
    expectedRevision?: number,
  ): Promise<unknown> {
    const command = this.commands.get(token);
    if (
      !this.clients.owns(ownerUserId, clientId, clientToken) ||
      !command ||
      command.ownerUserId !== ownerUserId ||
      command.clientId !== clientId ||
      command.clientToken !== clientToken
    )
      return Promise.resolve({ kind: 'blocked' });
    // Browser/network duplicate consumes do not repeat a CAS or authorize a second navigation.
    if (command.consumed) return Promise.resolve({ kind: 'blocked', reason: 'already_consumed' });
    command.consumed = command.authorize(expectedRevision).then((grant) =>
      // Revocation fences future effects; it cannot undo a CAS the draft owner already committed.
      (grant && typeof grant === 'object' && 'kind' in grant && grant.kind === 'updated') ||
      (this.commands.get(token) === command &&
        this.clients.owns(ownerUserId, clientId, clientToken) &&
        !command.signal.aborted &&
        command.expiresAt > Date.now())
        ? grant
        : { kind: 'blocked' },
    );
    return command.consumed;
  }

  close(): void {
    for (const [token, command] of this.commands)
      this.deps.emitter.emit(
        command.ownerUserId,
        'home:cancel',
        { token, clientId: command.clientId },
        this.clients.connections(command.ownerUserId, command.clientId),
      );
    this.commands.clear();
    this.clients.clear();
  }

  private async authorize(
    request: HomeActionRequest,
    original: HomeOwnedTarget,
    choice: Extract<PageChoice, { kind: 'act' }>,
    expiresAt: number,
    expectedRevision?: number,
  ) {
    const currentTargets = await this.targets(request, { id: original.pageId });
    const target = currentTargets.find(
      (candidate) => candidate.id === original.id && candidate.revision === original.revision,
    );
    if (!target) return { kind: 'stale' };
    if (Date.now() >= expiresAt || request.signal.aborted || !(await this.deps.isCurrent(request)))
      return { kind: 'stale' };
    const common = { clientId: target.clientId, baseRoute: target.route, expiresAt };
    if (target.ownerAction.kind !== 'draft') return { kind: 'navigate', ...common, action: target.ownerAction };
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision === undefined ||
      expectedRevision < 0 ||
      choice.operation !== 'fill' ||
      !choice.value
    )
      return { kind: 'blocked' };
    const result = await appendHomeOwnerDraft({
      ...this.deps,
      ownerUserId: request.userId,
      threadId: target.ownerAction.threadId,
      expectedRevision,
      literal: choice.value,
      isCurrent: () => this.deps.isCurrent(request),
      signal: request.signal,
    });
    return result.kind === 'updated' ? { ...result, ...common } : result;
  }
}
