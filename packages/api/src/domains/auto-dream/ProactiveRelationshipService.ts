import type { CatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { AutoDreamStore } from './AutoDreamStore.js';
import type { ProactiveVisitRecord } from './proactive-relationship-contract.js';

export type ProactiveDeliveryFaultStage = 'before_message_append' | 'after_message_append' | 'after_message_attach';

export interface ProactiveCanonicalBroadcast {
  threadId: string;
  messageId: string;
  catId: string;
  content: string;
  timestamp: number;
  visitId: string;
  intentId: string;
}

export interface ProactiveCanonicalMessageBroadcaster {
  publish(message: ProactiveCanonicalBroadcast): void | Promise<void>;
}

interface ProactiveRelationshipServiceOptions {
  store: AutoDreamStore;
  messageStore: Pick<IMessageStore, 'append' | 'getById' | 'getByIdempotencyKey' | 'getByThread'>;
  broadcaster?: ProactiveCanonicalMessageBroadcaster;
  now?: () => number;
  faultInjector?: (stage: ProactiveDeliveryFaultStage) => void;
}

export interface ProactiveDeliveryResult {
  visit: ProactiveVisitRecord;
  message: StoredMessage;
  attached: boolean;
}

export interface ProactiveWakeContext {
  pendingCues: Array<{
    cueId: string;
    normalizedClaim: string;
    reason: string;
    sourceThreadId: string;
    sourceMessageId?: string;
  }>;
  ownedSeeds: Array<{
    seedId: string;
    claim: string;
    sourceKind: 'cue' | 'originated';
    sourceCueId?: string;
  }>;
  recentEchoes: Array<{
    echoId: string;
    visitId: string;
    seedId: string;
    kind: string;
    sourceThreadId?: string;
    sourceMessageId?: string;
  }>;
}

const WAKE_CONTEXT_LIMIT = 8;

export class ProactiveRelationshipService {
  private readonly now: () => number;

  constructor(private readonly options: ProactiveRelationshipServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async reconcileVisit(ownerUserId: string, catId: string, visitId: string): Promise<ProactiveDeliveryResult> {
    const visit = await this.options.store.proactive.getVisit(ownerUserId, catId, visitId);
    if (visit.canonicalMessageId) {
      const message = await this.options.messageStore.getById(visit.canonicalMessageId);
      if (!message || message.threadId !== visit.homeThreadId) {
        throw new Error(`F272 canonical message ${visit.canonicalMessageId} is missing from ${visit.homeThreadId}`);
      }
      return { visit, message, attached: false };
    }
    const pendingMessageBody = visit.pendingMessageBody;
    if (!pendingMessageBody) throw new Error(`F272 visit ${visit.visitId} has no pending canonical message`);

    this.options.faultInjector?.('before_message_append');
    const idempotencyKey = proactiveMessageIdempotencyKey(visit.visitId);
    const existing = await this.options.messageStore.getByIdempotencyKey(
      visit.ownerUserId,
      visit.homeThreadId,
      idempotencyKey,
    );
    const message =
      existing ??
      (await this.options.messageStore.append(
        buildCanonicalMessage(visit, pendingMessageBody, idempotencyKey, this.now()),
      ));
    assertMessageMatchesVisit(message, visit);
    this.options.faultInjector?.('after_message_append');

    const attached = await this.options.store.proactive.attachCanonicalMessage(ownerUserId, catId, {
      visitId: visit.visitId,
      threadId: visit.homeThreadId,
      messageId: message.id,
    });
    this.options.faultInjector?.('after_message_attach');
    if (attached.attached) {
      await this.options.broadcaster?.publish({
        threadId: message.threadId,
        messageId: message.id,
        catId: visit.catId,
        content: message.content,
        timestamp: message.timestamp,
        visitId: visit.visitId,
        intentId: visit.intentId,
      });
    }
    return { visit: attached.visit, message, attached: attached.attached };
  }

  async reconcilePending(ownerUserId: string, limit = 100): Promise<{ reconciled: number; failed: number }> {
    const pendingDeliveries = await this.options.store.proactive.listPendingDeliveries(ownerUserId, limit);
    const unprojectedVisits = await this.options.store.proactive.listUnprojectedVisits(ownerUserId, limit);
    let reconciled = 0;
    let failed = 0;
    for (const visit of pendingDeliveries) {
      try {
        await this.reconcileVisit(ownerUserId, visit.catId, visit.visitId);
        reconciled += 1;
      } catch {
        failed += 1;
      }
    }
    for (const visit of unprojectedVisits) {
      try {
        await this.options.store.proactive.cancelUnseen(ownerUserId, visit.catId, visit.visitId);
        reconciled += 1;
      } catch {
        failed += 1;
      }
    }
    return { reconciled, failed };
  }

  async reconcileNaturalEchoes(ownerUserId: string, catId: string): Promise<{ reconciled: number }> {
    const config = await this.options.store.getCatLifeConfig(ownerUserId, catId);
    if (!config?.enabled) return { reconciled: 0 };
    const visits = (
      await this.options.store.proactive.listVisits(ownerUserId, catId, {
        status: 'projected',
        limit: 50,
      })
    ).filter((visit) => visit.canonicalMessageId && visit.homeThreadId === config.bedroomThreadId);
    if (visits.length === 0) return { reconciled: 0 };

    const messages = await this.options.messageStore.getByThread(config.bedroomThreadId, 500, ownerUserId);
    const positions = new Map(messages.map((message, index) => [message.id, index]));
    const available = new Map(visits.map((visit) => [visit.canonicalMessageId as string, visit]));
    let reconciled = 0;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || message.userId !== ownerUserId || message.catId !== null) continue;
      const existing = await this.options.store.proactive.findNaturalEchoBySource(
        ownerUserId,
        config.bedroomThreadId,
        message.id,
      );
      if (existing) continue;
      const visit = selectNaturalEchoVisit(message, index, available, positions);
      if (!visit?.canonicalMessageId) continue;
      await this.options.store.proactive.recordNaturalEcho(ownerUserId, catId, {
        visitId: visit.visitId,
        kind: 'natural_reply',
        sourceThreadId: config.bedroomThreadId,
        sourceMessageId: message.id,
      });
      available.delete(visit.canonicalMessageId);
      reconciled += 1;
    }
    return { reconciled };
  }

  async loadWakeContext(ownerUserId: string, catId: string): Promise<ProactiveWakeContext> {
    const [pendingCues, ownedSeeds, recentEchoes] = await Promise.all([
      this.options.store.listPrivateCues(ownerUserId, catId, { status: 'pending', limit: WAKE_CONTEXT_LIMIT }),
      this.options.store.listOwnedSeeds(ownerUserId, catId, { status: 'owned', limit: WAKE_CONTEXT_LIMIT }),
      this.options.store.proactive.listEchoes(ownerUserId, catId, { limit: WAKE_CONTEXT_LIMIT }),
    ]);
    return {
      pendingCues: pendingCues.map((cue) => ({
        cueId: cue.cueId,
        normalizedClaim: cue.normalizedClaim,
        reason: cue.reason,
        sourceThreadId: cue.sourceRef.threadId,
        ...(cue.sourceRef.messageId ? { sourceMessageId: cue.sourceRef.messageId } : {}),
      })),
      ownedSeeds: ownedSeeds.map((seed) => ({
        seedId: seed.seedId,
        claim: seed.claim,
        sourceKind: seed.sourceKind,
        ...(seed.sourceCueId ? { sourceCueId: seed.sourceCueId } : {}),
      })),
      recentEchoes: recentEchoes.map((echo) => ({
        echoId: echo.echoId,
        visitId: echo.visitId,
        seedId: echo.seedId,
        kind: echo.kind,
        ...(echo.sourceThreadId ? { sourceThreadId: echo.sourceThreadId } : {}),
        ...(echo.sourceMessageId ? { sourceMessageId: echo.sourceMessageId } : {}),
      })),
    };
  }
}

export function proactiveMessageIdempotencyKey(visitId: string): string {
  return `f272-proactive-visit:${visitId}`;
}

function buildCanonicalMessage(
  visit: ProactiveVisitRecord,
  content: string,
  idempotencyKey: string,
  timestamp: number,
) {
  return {
    threadId: visit.homeThreadId,
    userId: visit.ownerUserId,
    catId: visit.catId as CatId,
    content,
    mentions: [] as CatId[],
    origin: 'callback' as const,
    timestamp,
    idempotencyKey,
    extra: {
      isExplicitPost: true,
      proactive: { visitId: visit.visitId, intentId: visit.intentId, source: 'private_time' as const },
    },
  };
}

function assertMessageMatchesVisit(message: StoredMessage, visit: ProactiveVisitRecord): void {
  const proactive = message.extra?.proactive;
  const matches =
    message.userId === visit.ownerUserId &&
    message.threadId === visit.homeThreadId &&
    message.catId === visit.catId &&
    message.content === visit.pendingMessageBody &&
    proactive?.visitId === visit.visitId &&
    proactive.intentId === visit.intentId &&
    proactive.source === 'private_time';
  if (!matches) throw new Error(`F272 idempotency collision for visit ${visit.visitId}`);
}

function selectNaturalEchoVisit(
  message: StoredMessage,
  messageIndex: number,
  available: Map<string, ProactiveVisitRecord>,
  positions: Map<string, number>,
): ProactiveVisitRecord | null {
  if (message.replyTo) {
    const explicit = available.get(message.replyTo);
    const canonicalIndex = positions.get(message.replyTo);
    return explicit && canonicalIndex !== undefined && canonicalIndex < messageIndex ? explicit : null;
  }
  let latest: ProactiveVisitRecord | null = null;
  let latestIndex = -1;
  for (const [canonicalMessageId, visit] of available) {
    const canonicalIndex = positions.get(canonicalMessageId);
    if (canonicalIndex !== undefined && canonicalIndex < messageIndex && canonicalIndex > latestIndex) {
      latest = visit;
      latestIndex = canonicalIndex;
    }
  }
  return latest;
}
