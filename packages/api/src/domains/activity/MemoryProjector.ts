/**
 * Memory Projector (ADR-023)
 *
 * Subscribes to ActivityEventBus and forwards high-value events to F102
 * EvidenceStore. Applies promotion rules defined in ADR-023 §Memory
 * promotion rules — only events that merit memory crystallization are
 * forwarded; noisy lifecycle events are dropped.
 *
 * Promotion tiers:
 *   Always  — deep_collab_completed, bug_caught, evidence_cited
 *   Conditional — review_submitted (hasFindings), decision_confirmed (threadId)
 *   Never  — tool_used, message_sent, session_sealed, multi_mention_*, clarification_requested
 */

import type { ActivityEvent, ActivityEventType } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import type { EvidenceKind } from '../memory/interfaces.js';
import type { ActivityEventBus } from './ActivityEventBus.js';

const log = createModuleLogger('memory-projector');

/** Subset of IEvidenceStore — keeps the projector decoupled from full interface. */
interface EvidenceStoreLike {
  upsert(items: EvidenceUpsertItem[]): Promise<void>;
}

interface EvidenceUpsertItem {
  anchor: string;
  kind: EvidenceKind;
  status: 'active';
  title: string;
  summary?: string;
  keywords?: string[];
  updatedAt: string;
}

// ── Promotion rules ────────────────────────────────────────────────────

const ALWAYS_PROMOTE = new Set<ActivityEventType>(['deep_collab_completed', 'bug_caught', 'evidence_cited']);

const CONDITIONAL_PROMOTE = new Set<ActivityEventType>(['review_submitted', 'decision_confirmed', 'feedback_applied']);

/** Map event type → EvidenceKind for promoted events. */
const EVENT_KIND: Partial<Record<ActivityEventType, EvidenceKind>> = {
  bug_caught: 'lesson',
  deep_collab_completed: 'discussion',
  evidence_cited: 'research',
  review_submitted: 'discussion',
  decision_confirmed: 'decision',
  feedback_applied: 'lesson',
};

// ── Anchor builders (semantic keys for upsert idempotency) ─────────────

function buildAnchor(event: ActivityEvent): string {
  const m = event.metadata;
  switch (event.type) {
    case 'decision_confirmed':
      return `activity-decision-${(m.blockId as string) ?? event.threadId ?? event.timestamp}`;
    case 'deep_collab_completed': {
      // Fires per-responder — use sorted participants as stable dedup key
      const parts = ((m.participants as string[]) ?? []).slice().sort().join('+');
      return `activity-collab-${event.threadId ?? 'unknown'}-${parts || event.timestamp}`;
    }
    case 'review_submitted':
      return `activity-review-${event.actorId}-${event.threadId ?? 'unknown'}-${(m.taskId as string) ?? event.timestamp}`;
    case 'bug_caught':
      return `activity-bug-${event.actorId}-${event.threadId ?? 'unknown'}-${event.timestamp}`;
    case 'evidence_cited':
      return `activity-cite-${event.actorId}-${(m.citedAnchor as string) ?? event.timestamp}`;
    case 'feedback_applied':
      return `activity-feedback-${event.actorId}-${(m.sourceMessageId as string) ?? event.timestamp}`;
    default:
      return `activity-${event.type}-${event.timestamp}`;
  }
}

// ── Summary templates ──────────────────────────────────────────────────

function buildSummary(event: ActivityEvent): string {
  // Emitter-supplied summary takes precedence
  if (typeof event.metadata.summary === 'string') return event.metadata.summary;

  switch (event.type) {
    case 'bug_caught':
      return `${event.actorId} identified a bug`;
    case 'deep_collab_completed':
      return `Deep collaboration completed with ${((event.metadata.participants as string[]) ?? []).join(', ') || 'multiple cats'}`;
    case 'evidence_cited':
      return `${event.actorId} cited evidence: ${(event.metadata.citedAnchor as string) ?? 'unknown'}`;
    case 'review_submitted':
      return `Code review by ${event.actorId} with ${(event.metadata.findingCount as number) ?? 0} findings`;
    case 'decision_confirmed':
      return 'Direction confirmed by co-creator';
    case 'feedback_applied':
      return `Feedback adopted by ${event.actorId}`;
    default:
      return event.type;
  }
}

// ── Title templates ──────────────────────────────────���─────────────────

function buildTitle(event: ActivityEvent): string {
  switch (event.type) {
    case 'bug_caught':
      return `Bug caught by ${event.actorId}`;
    case 'deep_collab_completed':
      return 'Deep collaboration completed';
    case 'evidence_cited':
      return `Evidence cited: ${(event.metadata.citedAnchor as string) ?? 'unknown'}`;
    case 'review_submitted':
      return `Review by ${event.actorId}`;
    case 'decision_confirmed':
      return 'Direction confirmed';
    case 'feedback_applied':
      return `Feedback applied by ${event.actorId}`;
    default:
      return event.type;
  }
}

// ── Conditional promotion checks ───────────────────────────────────────

function passesCondition(event: ActivityEvent): boolean {
  switch (event.type) {
    case 'review_submitted':
      return event.metadata.hasFindings === true;
    case 'decision_confirmed':
      return event.threadId != null;
    case 'feedback_applied':
      // Always promote when implemented — feedback adoption is high-value
      return true;
    default:
      return false;
  }
}

// ── Projector class ────────────────────────────────────────────────────

export class MemoryProjector {
  constructor(
    private readonly bus: ActivityEventBus,
    private readonly evidenceStore: EvidenceStoreLike,
  ) {
    this.bus.on(this.handleEvent);
    log.info('MemoryProjector subscribed to ActivityEventBus');
  }

  private handleEvent = (event: ActivityEvent): void => {
    try {
      if (!this.shouldPromote(event)) return;

      const kind = EVENT_KIND[event.type];
      if (!kind) return;

      const item: EvidenceUpsertItem = {
        anchor: buildAnchor(event),
        kind,
        status: 'active',
        title: buildTitle(event),
        summary: buildSummary(event),
        keywords: this.extractKeywords(event),
        updatedAt: event.timestamp,
      };

      // Fire-and-forget async upsert — errors are caught below
      void this.evidenceStore.upsert([item]).catch((err: unknown) => {
        log.warn({ err, anchor: item.anchor, type: event.type }, 'MemoryProjector upsert failed');
      });
    } catch (err: unknown) {
      log.warn({ err, type: event.type, actorId: event.actorId }, 'MemoryProjector error');
    }
  };

  private shouldPromote(event: ActivityEvent): boolean {
    if (ALWAYS_PROMOTE.has(event.type)) return true;
    if (CONDITIONAL_PROMOTE.has(event.type)) return passesCondition(event);
    return false;
  }

  private extractKeywords(event: ActivityEvent): string[] {
    const kw: string[] = [event.type];
    if (event.actorId && event.actorId !== 'co-creator') kw.push(event.actorId);
    if (event.threadId) kw.push(`thread:${event.threadId}`);
    return kw;
  }

  dispose(): void {
    this.bus.off(this.handleEvent);
  }
}
