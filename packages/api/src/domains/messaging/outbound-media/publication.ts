/**
 * F202 W2-5b — publish a deferred Host media message exactly once, after its media has become
 * Host media references or has been degraded in the open.
 *
 * The append seam writes such a message with `mediaPublication: 'deferred'` and registers a
 * pending row; the Hub already shows the message. This job then, per target:
 *  - a Host-served route (`/uploads/…`, `/api/tts/audio/…`, …) → whitelisted path → media ledger;
 *  - a `data:` URL → decoded bytes → media ledger;
 *  - an external `https://` URL → a text element carrying the link (the Host does not fetch it);
 *  - text-only audio (voice mode) → speech synthesized inside one per-message budget → ledger,
 *    or the legacy "🔊 语音" card when the budget runs out or synthesis fails;
 *  - anything unresolvable → a text label with no locator.
 * Host-produced media is registered without an owner instance: a package may read it only through
 * the delivery grant it holds while its action runs (b2).
 *
 * EXACTLY ONCE. The row moves pending → publishing (elements fixed) → published. The event key is
 * the same deterministic `publish:<id>:1` the seam uses, and the append carries a durable fence
 * with no expiry, so a crash or a failed settlement write after the append re-appends into the
 * dedupe however late recovery runs and even if the event was trimmed meanwhile. The fence is
 * released only after `published` is recorded — the one point after which no retry can happen.
 * Elements are never recomputed after `publishing`.
 */
import type { MessageElement } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { projectEnvelope } from '../envelope.js';
import type { EventLogStore } from '../stores/ports.js';
import { clampRetention } from '../stores/ports.js';
import type { HostMediaPathResolver } from './host-media-paths.js';
import type { OutboundMediaStore } from './store.js';
import {
  extensionForMimeType,
  mimeTypeForName,
  type OutboundMediaTarget,
  planOutboundMedia,
  usableFileName,
} from './targets.js';

/** Total speech time per message — the legacy outbound delivery bound (`routes/messages.ts` 10 s). */
export const OUTBOUND_SPEECH_BUDGET_MS = 10_000;
/** How far back startup recovery looks for a deferred message whose row was never registered. */
export const OUTBOUND_MEDIA_RECOVERY_SCAN = 500;

export interface OutboundMediaLedger {
  register(
    source: Uint8Array | { readonly path: string },
    meta: { readonly mimeType?: string; readonly importKey?: string },
  ): Promise<string>;
}

export interface OutboundSpeechSynthesizer {
  /** A Host-served file with the speech. May ignore the signal: the caller stops waiting anyway. */
  synthesize(
    text: string,
    voice: { readonly catId?: string },
    signal: AbortSignal,
  ): Promise<{ readonly path: string; readonly mimeType?: string }>;
}

export interface OutboundMediaPublicationDeps {
  readonly store: OutboundMediaStore;
  readonly messages: Pick<IMessageStore, 'getById' | 'getRecent'>;
  readonly events: Pick<EventLogStore, 'append' | 'releaseFence'>;
  readonly ledger: OutboundMediaLedger;
  readonly resolvePath: HostMediaPathResolver;
  readonly speech?: OutboundSpeechSynthesizer;
  readonly onPublished?: (threadId: string) => void;
  /** Required: a job that fails leaves a message no subscriber receives until recovery. */
  onPublishFailure(error: unknown, messageId: string): void;
  readonly retentionCount?: number;
  readonly speechBudgetMs?: number;
  readonly now?: () => number;
}

type Element = MessageElement;

function decodeDataUrl(url: string): { bytes: Uint8Array; mimeType?: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!match?.[2]) return null; // only base64 payloads carry binary media
  const bytes = Buffer.from(match[3] ?? '', 'base64');
  if (bytes.byteLength === 0) return null;
  return match[1] ? { bytes, mimeType: match[1] } : { bytes };
}

function labelled(target: Extract<OutboundMediaTarget, { kind: 'media' }>, text: string): Element {
  return { elementId: target.elementId, kind: 'text', payload: { text } };
}

function unavailable(target: Extract<OutboundMediaTarget, { kind: 'media' }>): Element {
  return labelled(target, `[${target.type}: ${Array.from(target.label).slice(0, 120).join('')}]`);
}

function speechCard(target: Extract<OutboundMediaTarget, { kind: 'speech' }>): Element {
  return {
    elementId: target.elementId,
    kind: 'rich_block',
    payload: { id: target.blockId, kind: 'card', v: 1, title: '🔊 语音', bodyMarkdown: target.text },
  };
}

export class OutboundMediaPublication {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: OutboundMediaPublicationDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Called by the append seam right after it wrote a deferred message. */
  async register(stored: StoredMessage): Promise<void> {
    await this.deps.store.putIfAbsent({
      messageId: stored.id,
      threadId: stored.threadId,
      createdAt: this.now(),
      state: 'pending',
    });
  }

  /** Starts, or joins, the one job for this message. Never rejects. */
  schedule(messageId: string): Promise<void> {
    const existing = this.running.get(messageId);
    if (existing) return existing;
    const job = this.run(messageId)
      .catch((error: unknown) => this.deps.onPublishFailure(error, messageId))
      .finally(() => this.running.delete(messageId));
    this.running.set(messageId, job);
    return job;
  }

  /**
   * Startup: finish every unpublished row, and adopt a deferred message whose row the crash cut
   * off (written with the marker, process gone before the row existed).
   */
  async recover(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const row of await this.deps.store.list()) {
      if (row.state !== 'published') jobs.push(this.schedule(row.messageId));
    }
    for (const msg of await this.deps.messages.getRecent(OUTBOUND_MEDIA_RECOVERY_SCAN)) {
      if (msg.extra?.mediaPublication !== 'deferred' || (await this.deps.store.get(msg.id))) continue;
      await this.register(msg);
      jobs.push(this.schedule(msg.id));
    }
    await Promise.all(jobs);
  }

  private async run(messageId: string): Promise<void> {
    let row = await this.deps.store.get(messageId);
    if (!row || row.state === 'published') return;
    const msg = await this.deps.messages.getById(messageId);
    if (row.state === 'pending') {
      const elements = msg ? await this.materialize(msg) : [];
      row = await this.deps.store.update(messageId, (current) =>
        current.state === 'pending' ? { ...current, state: 'publishing', elements } : current,
      );
      if (!row) return;
    }
    if (row.state !== 'publishing') return;

    const envelope = msg ? projectEnvelope(msg, { hostMedia: row.elements ?? [] }) : null;
    let publishedSequence: number | undefined;
    if (msg && envelope) {
      const result = await this.deps.events.append(
        msg.threadId,
        `publish:${msg.id}:1`,
        { eventId: `ev_pub_${msg.id}_1`, type: 'message.publish', envelope },
        clampRetention(this.deps.retentionCount),
        undefined,
        // The row may still say `publishing` after this append succeeded (a failed settlement
        // write); recovery then re-appends. The fence makes that converge even after a trim.
        { durableFence: true },
      );
      publishedSequence = result.sequence;
    }
    // A message deleted before publication has nothing to publish; it is closed all the same.
    await this.deps.store.update(messageId, (current) => ({
      ...current,
      state: 'published',
      ...(publishedSequence === undefined ? {} : { publishedSequence }),
    }));
    if (msg && envelope) {
      // Only now can no retry happen (a `published` row is never run, recovered or adopted
      // again), so only now may the fence go. A release that fails leaves one inert key behind;
      // it never allows a second publish.
      try {
        await this.deps.events.releaseFence(msg.threadId, `publish:${msg.id}:1`);
      } catch (error) {
        console.warn('[F202 W2-5b] publication fence not released', {
          messageId: msg.id,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
      this.deps.onPublished?.(msg.threadId);
    }
  }

  private async materialize(msg: StoredMessage): Promise<Element[]> {
    const speechDeadline = this.now() + (this.deps.speechBudgetMs ?? OUTBOUND_SPEECH_BUDGET_MS);
    const elements: Element[] = [];
    for (const target of planOutboundMedia(msg)) {
      elements.push(
        target.kind === 'speech' ? await this.speak(msg, target, speechDeadline) : await this.importMedia(msg, target),
      );
    }
    return elements;
  }

  private async importMedia(msg: StoredMessage, target: Extract<OutboundMediaTarget, { kind: 'media' }>) {
    const importKey = `${msg.id}:${target.elementId}`;
    try {
      if (target.url.startsWith('data:')) {
        const decoded = decodeDataUrl(target.url);
        if (!decoded) return unavailable(target);
        const mimeType = decoded.mimeType ?? target.mimeType;
        const reference = await this.deps.ledger.register(decoded.bytes, {
          ...(mimeType ? { mimeType } : {}),
          importKey,
        });
        const extension = extensionForMimeType(mimeType);
        const fileName = target.fileName ?? (extension ? `${target.type}${extension}` : undefined);
        return this.mediaRef(target, reference, fileName);
      }
      if (/^https:\/\//i.test(target.url)) return labelled(target, `${target.label}: ${target.url}`);
      const path = this.deps.resolvePath(target.url);
      if (!path) return unavailable(target);
      const mimeType = target.mimeType ?? mimeTypeForName(path);
      const reference = await this.deps.ledger.register({ path }, { ...(mimeType ? { mimeType } : {}), importKey });
      return this.mediaRef(target, reference, target.fileName ?? usableFileName(path));
    } catch (error) {
      console.warn('[F202 W2-5b] outbound media degraded', {
        messageId: msg.id,
        elementId: target.elementId,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return unavailable(target);
    }
  }

  private mediaRef(
    target: Extract<OutboundMediaTarget, { kind: 'media' }>,
    reference: string,
    fileName: string | undefined,
  ): Element {
    return {
      elementId: target.elementId,
      kind: 'media_ref',
      payload: { type: target.type, reference, ...(fileName ? { fileName } : {}) },
    };
  }

  private async speak(
    msg: StoredMessage,
    target: Extract<OutboundMediaTarget, { kind: 'speech' }>,
    deadline: number,
  ): Promise<Element> {
    const remaining = deadline - this.now();
    if (!this.deps.speech || remaining <= 0) return speechCard(target);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, remaining);
      timer.unref?.();
    });
    try {
      const voice = target.speaker ?? msg.catId ?? undefined;
      const produced = await Promise.race([
        this.deps.speech.synthesize(target.text, voice ? { catId: voice } : {}, controller.signal),
        expired,
      ]);
      // A result that lands after the budget is never written back: the card has already won.
      if (!produced || controller.signal.aborted) return speechCard(target);
      const mimeType = produced.mimeType ?? mimeTypeForName(produced.path) ?? 'audio/wav';
      const reference = await this.deps.ledger.register(
        { path: produced.path },
        { mimeType, importKey: `${msg.id}:${target.elementId}` },
      );
      const extension = extensionForMimeType(mimeType);
      return {
        elementId: target.elementId,
        kind: 'media_ref',
        payload: { type: 'audio', reference, ...(extension ? { fileName: `voice${extension}` } : {}) },
      };
    } catch {
      return speechCard(target);
    } finally {
      clearTimeout(timer);
    }
  }
}
