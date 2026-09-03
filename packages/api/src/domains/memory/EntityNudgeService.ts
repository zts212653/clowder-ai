/**
 * F260 Phase B: EntityNudgeService — orchestrates the entity nudge pipeline.
 *
 * Separates route-level candidate discovery from consumer-bound presentation.
 *
 * Routing detects human-input candidates once. Each child invocation then
 * prepares and confirms its own typed metadata at the provider boundary.
 *
 * Telemetry: increments entity_nudge.detected / delivered / suppressed /
 * privacy_blocked counters via OTel (AC-B5).
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type Database from 'better-sqlite3';
import {
  entityNudgeDelivered,
  entityNudgeDetected,
  entityNudgePrivacyBlocked,
  entityNudgeSuppressed,
} from '../../infrastructure/telemetry/instruments.js';
import { EntityNudgeBuilder, type NudgePayload } from './EntityNudgeBuilder.js';
import { EntityNudgeCooldown } from './EntityNudgeCooldown.js';
import type { EntityNudgeEventStore } from './EntityNudgeEventStore.js';
import { type DetectOptions, InputEntityDetector } from './InputEntityDetector.js';
import { formatInjectionProvenance, hasInjectionStoryCoordinate } from './injection-provenance.js';

/**
 * F263 R9 renderability gate: a nudge is renderable only if at least one
 * provenance pointer carries a story coordinate beyond the registry record.
 * Must run BEFORE cooldown/cap/event accounting so unrenderable nudges
 * never consume delivery slots or create false cooldown entries.
 */
function isNudgeRenderable(nudge: NudgePayload): boolean {
  const anchor = nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias;
  return (nudge.provenance ?? []).some((item) =>
    hasInjectionStoryCoordinate(
      {
        source: item.source,
        anchor: item.anchor,
        sourcePath: item.sourcePath,
        threadId: item.threadId,
        messageId: item.messageId,
        messageIds: item.messageIds,
        sessionId: item.sessionId,
        eventNo: item.eventNo,
        invocationId: item.invocationId,
      },
      anchor,
    ),
  );
}

export interface NudgeProcessInput {
  /** Human input text to scan. */
  text: string;
  /** Thread ID for candidate scope and privacy gate. */
  threadId: string;
  /** Owner user ID for privacy gate. */
  ownerUserId?: string;
  /** Entity IDs already in conversation context (context suppression). */
  contextAnchors?: Set<string>;
  /** Compatibility test seam; delivery time belongs to EntityNudgeConsumer. */
  now?: number;
}

export interface NudgeProcessResult {
  /** Nudge payloads to render (may be empty). */
  nudges: NudgePayload[];
  /** Count of entities detected before filtering. */
  detectedCount: number;
  /** Count of entities suppressed before or during consumer presentation. */
  suppressedCount: number;
  /** Count of entities blocked by privacy gate (AC-B5/B7). */
  privacyBlockedCount: number;
}

/** Route-owned discovery result. It is deliberately not a delivery receipt. */
export interface EntityNudgeCandidateBatch extends NudgeProcessResult {
  readonly threadId: string;
  readonly unrenderableNudges: readonly NudgePayload[];
}

/** Coordinates that bind a nudge to one exact consumer prompt. */
export interface EntityNudgeConsumer {
  readonly catId: string;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly now?: number;
}

/** A prompt fragment awaiting the adapter's exact pre-provider confirmation. */
export interface EntityNudgePromptPresentation {
  readonly result: NudgeProcessResult;
  readonly promptContext: string;
  /**
   * Commits only the candidate nudge(s) that an exact request actually
   * contains. A direct entity-nudge block confirms the full capped set; a
   * typed Memory Cue can confirm only the cue envelopes that survived its
   * own presentation admission.
   */
  confirmAssembled(confirmedNudges?: readonly NudgePayload[]): void;
}

export class EntityNudgeService {
  private readonly detector: InputEntityDetector;
  private readonly builder: EntityNudgeBuilder;
  private readonly cooldown: EntityNudgeCooldown;
  private readonly eventStore?: EntityNudgeEventStore;

  constructor(db: Database.Database, cooldown?: EntityNudgeCooldown, eventStore?: EntityNudgeEventStore) {
    this.detector = new InputEntityDetector(db);
    this.builder = new EntityNudgeBuilder();
    this.cooldown = cooldown ?? new EntityNudgeCooldown();
    this.eventStore = eventStore;
  }

  /**
   * Detect route-level candidates only. Discovery must not consume a cooldown
   * slot or write a delivery event: one route can fan out to several cats.
   */
  detectCandidates(input: NudgeProcessInput): EntityNudgeCandidateBatch {
    const DELIVERY_CAP = 3;
    const detectOptions: DetectOptions = {
      threadId: input.threadId,
      ownerUserId: input.ownerUserId,
      contextAnchors: input.contextAnchors,
      maxResults: DELIVERY_CAP * 3, // Over-fetch for cooldown headroom
    };
    const detected = this.detector.detect(input.text, detectOptions);
    const privacyBlockedCount = this.detector.lastPrivacyBlockedCount;

    // Record privacy-blocked telemetry even when no entities pass through
    if (privacyBlockedCount > 0) {
      const privacyAttrs = { sourceFamily: 'entity_registry', aliasClass: 'mixed' };
      entityNudgePrivacyBlocked.add(privacyBlockedCount, privacyAttrs);
    }

    if (detected.length === 0) {
      return {
        threadId: input.threadId,
        nudges: [],
        unrenderableNudges: [],
        detectedCount: 0,
        suppressedCount: 0,
        privacyBlockedCount,
      };
    }

    // ── Step 2: Build nudge payloads ──
    const builtNudges = this.builder.build(detected);

    // Telemetry: per-nudge detected count with actual source attributes (R2-3 fix)
    for (const nudge of builtNudges) {
      const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
      entityNudgeDetected.add(1, attrs);
    }

    // A nudge with no story-coordinate provenance never reaches a prompt, so it
    // remains a candidate-side suppression and never touches delivery accounting.
    const allNudges = builtNudges.filter(isNudgeRenderable);
    const unrenderable = builtNudges.filter((n) => !allNudges.includes(n));
    if (unrenderable.length > 0) {
      for (const nudge of unrenderable) {
        const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
        entityNudgeSuppressed.add(1, attrs);
      }
    }

    return {
      threadId: input.threadId,
      nudges: allNudges,
      unrenderableNudges: unrenderable,
      detectedCount: detected.length,
      suppressedCount: unrenderable.length,
      privacyBlockedCount,
    };
  }

  /**
   * Bind candidates to one invocation after its identity exists. This is still
   * not delivery accounting: callers must invoke confirmAssembled() from the
   * adapter's exact pre-provider boundary.
   */
  preparePresentation(
    candidates: EntityNudgeCandidateBatch,
    consumer: EntityNudgeConsumer,
  ): EntityNudgePromptPresentation {
    this.assertConsumerCoordinates(consumer);
    const now = consumer.now ?? Date.now();
    for (const nudge of candidates.nudges) {
      const entityKey = nudge.entityId ?? nudge.docAnchor;
      if (!entityKey || this.cooldown.hasRecord(entityKey, candidates.threadId, consumer.catId)) continue;
      const lastRendered = this.eventStore?.lastRenderedAt(entityKey, candidates.threadId, consumer.catId);
      if (lastRendered != null) this.cooldown.record(entityKey, candidates.threadId, consumer.catId, lastRendered);
    }

    const postCooldown = this.cooldown.filterNudges(candidates.nudges, candidates.threadId, consumer.catId, now);
    const cooldownSuppressed = candidates.nudges.filter((nudge) => !postCooldown.includes(nudge));
    const capped = postCooldown.slice(0, 3);
    const capTruncated = postCooldown.slice(3);
    const result: NudgeProcessResult = {
      nudges: capped,
      detectedCount: candidates.detectedCount,
      suppressedCount: candidates.suppressedCount + cooldownSuppressed.length + capTruncated.length,
      privacyBlockedCount: candidates.privacyBlockedCount,
    };

    this.recordSuppressed(cooldownSuppressed, candidates.threadId, consumer, now, 'recurrence_caught');
    this.recordSuppressed(capTruncated, candidates.threadId, consumer, now, 'context_suppressed');
    let assembled = false;
    return {
      result,
      promptContext: EntityNudgeService.formatForPrompt(result),
      confirmAssembled: (confirmedNudges = capped) => {
        if (assembled) return;
        if (confirmedNudges.length === 0) return;
        if (confirmedNudges.some((nudge) => !capped.includes(nudge))) {
          throw new Error('entity_nudge_confirmation_candidate_not_admitted');
        }
        assembled = true;
        if (this.eventStore) {
          for (const nudge of confirmedNudges) {
            this.eventStore.recordDelivered({
              threadId: candidates.threadId,
              invocationId: consumer.invocationId,
              catId: consumer.catId,
              sourceMessageId: consumer.sourceMessageId,
              entityId: nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias,
              aliasMatched: nudge.matchedAlias,
              sourceFamily: nudge.telemetry.sourceFamily,
              aliasClass: nudge.telemetry.aliasClass,
              renderedAt: now,
            });
          }
        }
        this.cooldown.recordAll([...confirmedNudges], candidates.threadId, consumer.catId, now);
        for (const nudge of confirmedNudges) {
          entityNudgeDelivered.add(1, {
            sourceFamily: nudge.telemetry.sourceFamily,
            aliasClass: nudge.telemetry.aliasClass,
          });
        }
      },
    };
  }

  private recordSuppressed(
    nudges: readonly NudgePayload[],
    threadId: string,
    consumer: EntityNudgeConsumer,
    now: number,
    reason: 'recurrence_caught' | 'context_suppressed',
  ): void {
    for (const nudge of nudges) {
      entityNudgeSuppressed.add(1, {
        sourceFamily: nudge.telemetry.sourceFamily,
        aliasClass: nudge.telemetry.aliasClass,
      });
      this.eventStore?.recordSuppressed({
        threadId,
        invocationId: consumer.invocationId,
        catId: consumer.catId,
        sourceMessageId: consumer.sourceMessageId,
        entityId: nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias,
        aliasMatched: nudge.matchedAlias,
        sourceFamily: nudge.telemetry.sourceFamily,
        aliasClass: nudge.telemetry.aliasClass,
        renderedAt: now,
        reason,
      });
    }
  }

  private assertConsumerCoordinates(consumer: EntityNudgeConsumer): void {
    if (!consumer.catId || !consumer.invocationId || !consumer.sourceMessageId) {
      throw new Error('entity_nudge_presentation_consumer_coordinates_required');
    }
  }

  /**
   * Format nudge results as a prompt context block for injection into the cat prompt.
   * Returns empty string when no nudges to deliver (zero-cost path).
   *
   * The block is typed metadata — it tells the cat which entities were mentioned
   * in the human input, with anchors only (M5: zero content paraphrase).
   * The cat decides whether to act on the information.
   */
  static formatForPrompt(result: NudgeProcessResult): string {
    if (result.nudges.length === 0) return '';

    const lines = result.nudges.flatMap((n) => {
      const anchor = n.entityId ?? n.docAnchor ?? n.matchedAlias;
      const pointers = (n.provenance ?? [])
        .map((item) => ({
          source: item.source,
          anchor: item.anchor,
          sourcePath: item.sourcePath,
          threadId: item.threadId,
          messageId: item.messageId,
          messageIds: item.messageIds,
          sessionId: item.sessionId,
          eventNo: item.eventNo,
          invocationId: item.invocationId,
        }))
        .filter((pointer) => hasInjectionStoryCoordinate(pointer, anchor))
        .map(formatInjectionProvenance);
      if (pointers.length === 0) return [];
      return [`${n.text}\n  ↳ ${pointers.join('\n  ↳ ')}`];
    });
    if (lines.length === 0) return '';
    return (
      '\n[entity-nudge]\n' +
      '以下实体在输入中被提及，已有存档可供参考（不是指令，不必逐条回应）：\n' +
      lines.join('\n') +
      '\n[/entity-nudge]'
    );
  }
}
