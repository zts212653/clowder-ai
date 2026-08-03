import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { inspectDeclaredPawFeelMessage, inspectPawFeelMessage } from '../friction/paw-feel-source.js';
import type { PawFeelDispositionService } from './service.js';

export type PawFeelHotIntakeResult =
  | { kind: 'ignored'; discoveredSignals: 0 }
  | { kind: 'cross_post_copy'; discoveredSignals: 0; markerCount: number }
  | { kind: 'canonical'; discoveredSignals: number };

export async function capturePawFeelSourceMessage(
  principal: { kind: 'cat'; id: string },
  message: StoredMessage,
  dispositionService: Pick<PawFeelDispositionService, 'discover'>,
): Promise<PawFeelHotIntakeResult> {
  if (!message.catId) throw new Error('typed paw-feel capture requires a cat-authored source message');
  if (message.catId !== principal.id) {
    throw new Error(`typed paw-feel capture source cat mismatch: expected ${principal.id}, got ${message.catId}`);
  }
  const inspection = inspectDeclaredPawFeelMessage(message);
  if (inspection.kind === 'ignored') return { kind: 'ignored', discoveredSignals: 0 };
  if (inspection.kind === 'cross_post_copy') {
    return { kind: 'cross_post_copy', discoveredSignals: 0, markerCount: inspection.markerCount };
  }
  for (const candidate of inspection.candidates) {
    await dispositionService.discover(candidate, {
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    });
  }
  return { kind: 'canonical', discoveredSignals: inspection.candidates.length };
}

export class PawFeelCaptureService {
  constructor(
    private readonly options: {
      messageStore: Pick<IMessageStore, 'getById'>;
      dispositionService: Pick<PawFeelDispositionService, 'discover'>;
    },
  ) {}

  async capture(principal: { kind: 'cat'; id: string }, sourceMessageId: string) {
    const message = await this.options.messageStore.getById(sourceMessageId);
    if (!message) throw new Error(`paw-feel source message ${sourceMessageId} not found`);
    const result = await capturePawFeelSourceMessage(principal, message, this.options.dispositionService);
    const inspection = inspectDeclaredPawFeelMessage(message);
    const signalIds =
      inspection.kind === 'canonical' ? inspection.candidates.map((candidate) => candidate.signalId) : [];
    return { sourceMessageId, ...result, signalIds };
  }
}

interface PawFeelCaptureIntent {
  invocationId: string;
  threadId: string;
  userId: string;
  catId: string;
  expiresAt: number;
}

export type PawFeelCaptureIntentResult =
  | { kind: 'ignored' }
  | {
      kind: 'captured';
      invocationId: string;
      sourceMessageId: string;
      discoveredSignals: number;
    };

/**
 * Ephemeral typed sidecar between an authenticated turn and its future
 * server-generated message ID. The durable F278 row still stores only the
 * sourceMessageId; marker text is never copied into this registry.
 */
export class PawFeelCaptureIntentSidecar {
  private readonly intents = new Map<string, PawFeelCaptureIntent>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly options: {
      dispositionService: Pick<PawFeelDispositionService, 'discover'>;
      now?: () => number;
      ttlMs?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1_000;
  }

  declare(principal: { kind: 'invocation'; invocationId: string; threadId: string; userId: string; catId: string }): {
    kind: 'declared';
    invocationId: string;
    expiresAt: number;
  } {
    this.pruneExpired();
    const intent = {
      invocationId: principal.invocationId,
      threadId: principal.threadId,
      userId: principal.userId,
      catId: principal.catId,
      expiresAt: this.now() + this.ttlMs,
    };
    const existing = this.intents.get(principal.invocationId);
    if (
      existing &&
      (existing.threadId !== intent.threadId || existing.userId !== intent.userId || existing.catId !== intent.catId)
    ) {
      throw new Error(`paw-feel capture intent identity collision: ${principal.invocationId}`);
    }
    this.intents.set(principal.invocationId, intent);
    return { kind: 'declared', invocationId: intent.invocationId, expiresAt: intent.expiresAt };
  }

  async capturePersistedMessage(message: StoredMessage): Promise<PawFeelCaptureIntentResult> {
    this.pruneExpired();
    const invocationId = message.extra?.stream?.turnInvocationId;
    if (!invocationId || message.origin !== 'stream' || !message.catId) return { kind: 'ignored' };
    const intent = this.intents.get(invocationId);
    if (
      !intent ||
      intent.threadId !== message.threadId ||
      intent.userId !== message.userId ||
      intent.catId !== message.catId
    ) {
      return { kind: 'ignored' };
    }
    if (inspectDeclaredPawFeelMessage(message).kind !== 'canonical') return { kind: 'ignored' };

    this.intents.delete(invocationId);
    try {
      const result = await capturePawFeelSourceMessage(
        { kind: 'cat', id: intent.catId },
        message,
        this.options.dispositionService,
      );
      return {
        kind: 'captured',
        invocationId,
        sourceMessageId: message.id,
        discoveredSignals: result.discoveredSignals,
      };
    } catch (error) {
      if (intent.expiresAt > this.now()) this.intents.set(invocationId, intent);
      throw error;
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [invocationId, intent] of this.intents) {
      if (intent.expiresAt <= now) this.intents.delete(invocationId);
    }
  }
}

export type PawFeelAppendIntakeResult =
  | PawFeelCaptureIntentResult
  | { kind: 'cross_post_copy'; discoveredSignals: 0; markerCount: number }
  | { kind: 'compatible'; discoveredSignals: number };

/**
 * Post-persist coordinator. Invocation proof wins and produces confirmed typed
 * provenance. Cat-authored standalone markers without invocation proof remain
 * visible as ambiguous compatibility rows; example-shaped prose stays out.
 */
export async function captureAppendedPawFeelMessage(
  message: StoredMessage,
  sidecar: Pick<PawFeelCaptureIntentSidecar, 'capturePersistedMessage'>,
  dispositionService: Pick<PawFeelDispositionService, 'discover'>,
): Promise<PawFeelAppendIntakeResult> {
  const typed = await sidecar.capturePersistedMessage(message);
  if (typed.kind === 'captured') return typed;
  if (!message.catId) return { kind: 'ignored' };

  const inspection = inspectDeclaredPawFeelMessage(message);
  if (inspection.kind === 'ignored') return { kind: 'ignored' };
  if (inspection.kind === 'cross_post_copy') {
    return { kind: 'cross_post_copy', discoveredSignals: 0, markerCount: inspection.markerCount };
  }
  for (const candidate of inspection.candidates) {
    await dispositionService.discover(candidate, {
      backfilled: false,
      captureMethod: 'legacy_parser',
      captureAssessment: 'ambiguous',
    });
  }
  return { kind: 'compatible', discoveredSignals: inspection.candidates.length };
}

/**
 * Compatibility-only parser for pre-activation history. New message append
 * hooks use captureAppendedPawFeelMessage's stricter standalone grammar instead.
 */
export async function ingestPawFeelMessage(
  message: StoredMessage,
  dispositionService: Pick<PawFeelDispositionService, 'discover'>,
): Promise<PawFeelHotIntakeResult> {
  const inspection = inspectPawFeelMessage(message);
  if (inspection.kind === 'ignored') return { kind: 'ignored', discoveredSignals: 0 };
  if (inspection.kind === 'cross_post_copy') {
    return { kind: 'cross_post_copy', discoveredSignals: 0, markerCount: inspection.markerCount };
  }

  for (const candidate of inspection.candidates) {
    await dispositionService.discover(candidate, {
      backfilled: false,
      captureMethod: 'legacy_parser',
      captureAssessment: 'ambiguous',
    });
  }
  return { kind: 'canonical', discoveredSignals: inspection.candidates.length };
}
