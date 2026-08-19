/**
 * F260 Phase B: EntityNudgeBuilder — turns DetectedEntity[] into nudge payloads.
 *
 * The nudge is typed metadata that piggybacks on system notice rendering but:
 *   - Is NOT stored as a canonical message (storable=false)
 *   - Is NOT indexed by evidence/digest/passage (indexable=false)
 *   - Contains ONLY anchor + metadata — zero content paraphrase (M5)
 *   - Carries telemetry payload for entity_nudge_outcome counters (AC-B5)
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type { DetectedEntity } from './InputEntityDetector.js';
import type { EntityProvenance } from './interfaces.js';

// ── Types ───────────────────────────────────────────────────────────────

/** Telemetry payload for entity_nudge_outcome (AC-B5). */
export interface NudgeTelemetry {
  /** Entity ID or doc anchor. */
  entityId?: string;
  docAnchor?: string;
  /** Source family: 'entity_registry' | 'doc_aliases'. */
  sourceFamily: 'entity_registry' | 'doc_aliases';
  /** Alias classification (entity type or 'doc'). */
  aliasClass: string;
  /** Detection confidence score. */
  confidence: number;
}

/** A structured nudge payload — typed metadata, not a stored message. */
export interface NudgePayload {
  /** Human-readable nudge text — anchor + type only, zero content (M5). */
  text: string;
  /** Discriminator: always 'entity_nudge'. */
  kind: 'entity_nudge';
  /** Entity ID (from entity_registry). */
  entityId?: string;
  /** Doc anchor (from doc_aliases). */
  docAnchor?: string;
  /** Matched alias text. */
  matchedAlias: string;
  /** AC-B6: Must NOT be stored as canonical message. */
  storable: false;
  /** AC-B6: Must NOT be indexed by evidence/digest/passage. */
  indexable: false;
  /** Provenance for rendering (AC-B2). */
  provenance?: EntityProvenance[];
  /** AC-B5: Telemetry payload for entity_nudge_outcome. */
  telemetry: NudgeTelemetry;
}

// ── Builder ─────────────────────────────────────────────────────────────

export class EntityNudgeBuilder {
  /**
   * Build nudge payloads from detected entities.
   * Each DetectedEntity → one NudgePayload.
   * Returns empty array for empty input.
   */
  build(detected: DetectedEntity[]): NudgePayload[] {
    if (!detected || detected.length === 0) return [];

    return detected.map((d) => this.buildOne(d));
  }

  private buildOne(d: DetectedEntity): NudgePayload {
    const anchor = d.entityId ?? d.docAnchor ?? d.matchedAlias;
    const typeLabel = d.sourceTable === 'entity_registry' ? d.type : '文档';

    // M5: only anchor + type + canonicalName — zero content paraphrase.
    // When canonicalName differs from matchedAlias, append it so the cat sees
    // the full display name (e.g. "未婚喵（→ 宪宪/fable-5）" instead of just "未婚喵").
    // canonicalName is operator-curated metadata, not content — M5/AC-B2 compliant.
    const showCanonical = d.canonicalName && d.canonicalName !== d.matchedAlias;
    const text = showCanonical
      ? `📌 「${d.matchedAlias}」→ ${anchor}（${typeLabel}：${d.canonicalName}）`
      : `📌 「${d.matchedAlias}」→ ${anchor}（${typeLabel}）`;

    return {
      text,
      kind: 'entity_nudge',
      entityId: d.entityId,
      docAnchor: d.docAnchor,
      matchedAlias: d.matchedAlias,
      storable: false,
      indexable: false,
      provenance: d.provenance,
      telemetry: {
        entityId: d.entityId,
        docAnchor: d.docAnchor,
        sourceFamily: d.sourceTable,
        aliasClass: d.type,
        confidence: d.confidence,
      },
    };
  }
}
