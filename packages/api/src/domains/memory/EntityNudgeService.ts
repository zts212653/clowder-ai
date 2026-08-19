/**
 * F260 Phase B: EntityNudgeService — orchestrates the entity nudge pipeline.
 *
 * Wraps InputEntityDetector + EntityNudgeBuilder + EntityNudgeCooldown
 * into a single service call: processInput(text, options) → NudgePayload[].
 *
 * Intended to be called from the message routing pipeline (route-serial.ts)
 * when a human message arrives. The returned NudgePayload[] is rendered as
 * typed metadata (system notice) — not stored in canonical messages.
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
  /** Thread ID for cooldown keying and privacy gate. */
  threadId: string;
  /** Owner user ID for privacy gate. */
  ownerUserId?: string;
  /** Entity IDs already in conversation context (context suppression). */
  contextAnchors?: Set<string>;
  /** Current timestamp (ms). Defaults to Date.now(). */
  now?: number;
}

export interface NudgeProcessResult {
  /** Nudge payloads to render (may be empty). */
  nudges: NudgePayload[];
  /** Count of entities detected before filtering. */
  detectedCount: number;
  /** Count of entities suppressed by cooldown. */
  suppressedCount: number;
  /** Count of entities blocked by privacy gate (AC-B5/B7). */
  privacyBlockedCount: number;
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
   * Process human input text for entity nudges.
   * Returns NudgePayload[] ready for typed-metadata rendering.
   *
   * Full pipeline: detect → build → cooldown filter → telemetry → record.
   */
  processInput(input: NudgeProcessInput): NudgeProcessResult {
    const now = input.now ?? Date.now();

    // ── Step 1: Detect entity references ──
    // Detect more candidates than the final cap — cooldown may suppress some,
    // and we want non-cooldown entities to fill the slots (R4 cap fix).
    // Final AC-B4 cap (3) is applied after cooldown filtering in Step 3.
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
      return { nudges: [], detectedCount: 0, suppressedCount: 0, privacyBlockedCount };
    }

    // ── Step 2: Build nudge payloads ──
    const builtNudges = this.builder.build(detected);

    // Telemetry: per-nudge detected count with actual source attributes (R2-3 fix)
    for (const nudge of builtNudges) {
      const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
      entityNudgeDetected.add(1, attrs);
    }

    // ── Step 2.1: Renderability gate (F263 R9 — must run before cap/cooldown) ──
    // A nudge with no story-coordinate provenance will never reach the prompt,
    // so it must not consume a delivery slot, enter cooldown, or record as delivered.
    const allNudges = builtNudges.filter(isNudgeRenderable);
    const unrenderable = builtNudges.filter((n) => !allNudges.includes(n));
    if (unrenderable.length > 0) {
      for (const nudge of unrenderable) {
        const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
        entityNudgeSuppressed.add(1, attrs);
      }
      if (this.eventStore) {
        for (const nudge of unrenderable) {
          this.eventStore.recordSuppressed({
            threadId: input.threadId,
            entityId: nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias,
            aliasMatched: nudge.matchedAlias,
            sourceFamily: nudge.telemetry.sourceFamily,
            aliasClass: nudge.telemetry.aliasClass,
            renderedAt: now,
            reason: 'no_story_coordinate',
          });
        }
      }
    }

    if (allNudges.length === 0) {
      return {
        nudges: [],
        detectedCount: detected.length,
        suppressedCount: unrenderable.length,
        privacyBlockedCount,
      };
    }

    // ── Step 2.5: Hydrate cooldown from persistent event store (restart continuity) ──
    // If the in-memory cooldown has no record for an entity but the persistent
    // event store does, pre-seed the cooldown. This ensures cooldown survives
    // process restarts without requiring Redis or external state.
    if (this.eventStore) {
      for (const nudge of allNudges) {
        const entityKey = nudge.entityId ?? nudge.docAnchor;
        if (entityKey && !this.cooldown.hasRecord(entityKey, input.threadId)) {
          const lastRendered = this.eventStore.lastRenderedAt(entityKey, input.threadId);
          if (lastRendered != null) {
            this.cooldown.record(entityKey, input.threadId, lastRendered);
          }
        }
      }
    }

    // ── Step 3: Cooldown filter (AC-B4) ──
    const postCooldown = this.cooldown.filterNudges(allNudges, input.threadId, now);
    const suppressedCount = allNudges.length - postCooldown.length;

    // Telemetry: suppressed nudges with per-nudge attributes
    if (suppressedCount > 0) {
      const suppressed = allNudges.filter((n) => !postCooldown.includes(n));
      for (const nudge of suppressed) {
        const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
        entityNudgeSuppressed.add(1, attrs);
      }
    }

    // ── Step 3.5: Apply delivery cap AFTER cooldown (R4 fix) ──
    // Detection over-fetches so cooldown-suppressed entities don't eat slots
    // that non-cooldown entities could fill. Cap applied here, not at detection.
    const capped = postCooldown.slice(0, DELIVERY_CAP);
    const capTruncated = postCooldown.slice(DELIVERY_CAP);

    // ── Step 3.6: Telemetry for cap-truncated entities (F260 regression) ──
    // Entities that passed cooldown but exceeded delivery cap are suppressed
    // with reason='context_suppressed' — making truncation visible in telemetry.
    const capTruncatedCount = capTruncated.length;
    if (capTruncatedCount > 0) {
      for (const nudge of capTruncated) {
        const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
        entityNudgeSuppressed.add(1, attrs);
      }
    }

    // ── Step 4: Record delivered nudges in cooldown + event store ──
    this.cooldown.recordAll(capped, input.threadId, now);

    // Telemetry: delivered nudges with per-nudge attributes
    for (const nudge of capped) {
      const attrs = { sourceFamily: nudge.telemetry.sourceFamily, aliasClass: nudge.telemetry.aliasClass };
      entityNudgeDelivered.add(1, attrs);
    }

    // AC-B5: Record events in persistent store (if wired).
    // Delivered nudges get outcome='delivered' (pending resolution);
    // cooldown-suppressed nudges get outcome='recurrence_caught';
    // cap-truncated nudges get outcome='context_suppressed' (F260 regression fix).
    if (this.eventStore) {
      for (const nudge of capped) {
        this.eventStore.recordDelivered({
          threadId: input.threadId,
          entityId: nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias,
          aliasMatched: nudge.matchedAlias,
          sourceFamily: nudge.telemetry.sourceFamily,
          aliasClass: nudge.telemetry.aliasClass,
          renderedAt: now,
        });
      }
      if (suppressedCount > 0) {
        const suppressed = allNudges.filter((n) => !postCooldown.includes(n));
        for (const nudge of suppressed) {
          this.eventStore.recordSuppressed({
            threadId: input.threadId,
            entityId: nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias,
            aliasMatched: nudge.matchedAlias,
            sourceFamily: nudge.telemetry.sourceFamily,
            aliasClass: nudge.telemetry.aliasClass,
            renderedAt: now,
            reason: 'recurrence_caught',
          });
        }
      }
      // Cap-truncated entities: visible in event store as context_suppressed
      if (capTruncatedCount > 0) {
        for (const nudge of capTruncated) {
          this.eventStore.recordSuppressed({
            threadId: input.threadId,
            entityId: nudge.entityId ?? nudge.docAnchor ?? nudge.matchedAlias,
            aliasMatched: nudge.matchedAlias,
            sourceFamily: nudge.telemetry.sourceFamily,
            aliasClass: nudge.telemetry.aliasClass,
            renderedAt: now,
            reason: 'context_suppressed',
          });
        }
      }
    }

    // Total suppressed = unrenderable + cooldown + cap-truncated (combined for result reporting)
    const totalSuppressed = unrenderable.length + suppressedCount + capTruncatedCount;

    return {
      nudges: capped,
      detectedCount: detected.length,
      suppressedCount: totalSuppressed,
      privacyBlockedCount,
    };
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
