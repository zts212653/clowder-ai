/**
 * F260 Phase B: InputEntityDetector — scans human input text for entity references.
 *
 * This is NOT a reuse of resolveQuery (砚砚 P1 correction). resolveQuery is a
 * search-query parser (short text, no spans, no confidence, CJK includes-match
 * has unacceptable false-positive rate on long messages).
 *
 * InputEntityDetector reuses:
 *   - alias storage (entity_aliases + doc_aliases tables)
 *   - normalizeEntityAlias + compileAliasMatcher logic
 *
 * InputEntityDetector adds:
 *   - confidence tiers (canonical > alias > doc-title)
 *   - context suppression (skip entities already in conversation context)
 *   - privacy gate (KD-7: private entities never leak to non-authorized threads)
 *   - maxResults noise control
 *
 * Red lines:
 *   M5: nudge = anchor + metadata only, zero content paraphrasing
 *   KD-8: no intent classification, only reports "this entity has an archive"
 *   KD-7: private entity in non-authorized thread = zero output
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type Database from 'better-sqlite3';
import { normalizeEntityAlias } from './EntityRegistry.js';
import type { EntityProvenance } from './interfaces.js';

// ── Types ───────────────────────────────────────────────────────────────

/** Confidence tiers for detected entities. */
export type ConfidenceTier = 'canonical' | 'alias' | 'doc-title';

const CONFIDENCE_SCORES: Record<ConfidenceTier, number> = {
  canonical: 1.0,
  alias: 0.7,
  'doc-title': 0.5,
};

/**
 * Type value weight for cap sorting (F260 post-close regression).
 * Concept entities are most valuable (relationship words, user-created knowledge);
 * doc/feature are contextual references; cat entities are known roster members
 * that everyone already knows and need not occupy nudge slots.
 */
const TYPE_WEIGHT: Record<string, number> = {
  concept: 3,
  doc: 2,
  feature: 2,
  cat: 1,
};

/** A detected entity reference in user input text. */
export interface DetectedEntity {
  /** entityId (from entity_registry) — mutually exclusive with docAnchor for doc_aliases source. */
  entityId?: string;
  /** doc anchor (from doc_aliases) — mutually exclusive with entityId for entity_registry source. */
  docAnchor?: string;
  /** The alias text that matched. */
  matchedAlias: string;
  /** Entity type from entity_registry, or 'doc' for doc_aliases. */
  type: string;
  /** Numerical confidence score (1.0 = canonical, 0.7 = alias, 0.5 = doc-title). */
  confidence: number;
  /** Which table the match came from. */
  sourceTable: 'entity_registry' | 'doc_aliases';
  /** Entity provenance (from entity_registry). */
  provenance?: EntityProvenance[];
  /** Entity stance (endorsed/disputed/unknown). */
  stance?: string;
  /** Visibility scope for privacy gating. */
  visibilityScope?: string;
  /** Canonical display name from entity_registry (may differ from matchedAlias). */
  canonicalName?: string;
}

/** Options for InputEntityDetector.detect(). */
export interface DetectOptions {
  /** Current thread ID — used for privacy gating. */
  threadId?: string;
  /** Owner user ID — private entities are visible to their owner. */
  ownerUserId?: string;
  /** Max results to return (noise control AC-B4, default 3). */
  maxResults?: number;
  /** Entity IDs / doc anchors already in conversation context — suppress these. */
  contextAnchors?: Set<string>;
}

// ── CJK detection (same logic as EntityRegistry) ────────────────────────

function hasCJK(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/** Compile a normalized alias string into a text matcher. */
function compileAliasMatcher(aliasNorm: string): ((textNorm: string) => boolean) | null {
  if (!aliasNorm) return null;
  if (hasCJK(aliasNorm)) return (textNorm) => textNorm.includes(aliasNorm);

  const escaped = aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@-])${escaped}(?=$|[^\\p{L}\\p{N}_@-])`, 'u');
  return (textNorm) => pattern.test(textNorm);
}

// ── Internal row types ──────────────────────────────────────────────────

interface EntityAliasRow {
  entity_id: string;
  alias: string;
  alias_norm: string;
  entity_type: string;
  canonical_name: string;
  provenance_json: string;
  stance: string;
  visibility_scope: string;
  status: string;
}

interface DocAliasRow {
  alias_norm: string;
  alias: string;
  doc_anchor: string;
  source: string;
  authority_tier: string;
  source_path: string | null;
}

function isSelfDescribingMatch(result: DetectedEntity): boolean {
  const anchor = result.entityId ?? result.docAnchor;
  if (!anchor) return false;

  // R9 二刀①: Cat roster entities are type-self-evident — every team member
  // knows who the cats are; nudging "codex is cat:codex" wastes a delivery
  // slot. operator 2026-07-17 pressure test: 8-entity message had 3 bare cat
  // names crowd out 家属喵 (concept with real provenance) via confidence-
  // first sort (canonical 1.0 > alias 0.7).  Only roster-only cats (whose
  // provenance is exclusively roster/system) are abstained; operator-approved
  // proposal-backed cat entities (e.g. cat:incident-guide with 'proposal' or
  // 'callback-thread' provenance) retain their delivery slots.
  //
  // Contract: buildRosterEntitySeeds() uses source='F032 roster' (not bare
  // 'roster'). We match with includes('roster') to stay forward-compatible
  // with any "X roster" variant without tight coupling to entity-seeds.ts.
  if (result.type === 'cat') {
    const prov = result.provenance ?? [];
    const hasNonRosterProvenance = prov.some((p) => p.source !== 'system' && !p.source.includes('roster'));
    if (!hasNonRosterProvenance) return true;
  }

  if (normalizeEntityAlias(result.matchedAlias) !== normalizeEntityAlias(anchor)) return false;
  if (result.sourceTable === 'doc_aliases') return true;
  return anchor.startsWith(`${result.type}:`);
}

// ── Core class ──────────────────────────────────────────────────────────

export class InputEntityDetector {
  /**
   * Number of entities suppressed by privacy gate in the last detect() call.
   * Read by EntityNudgeService for telemetry (AC-B5 privacy_blocked counter).
   */
  lastPrivacyBlockedCount = 0;

  constructor(private readonly db: Database.Database) {}

  /**
   * Scan input text for entity references from both entity_registry and doc_aliases.
   * Returns structured results sorted by confidence (descending).
   * Updates `lastPrivacyBlockedCount` for telemetry.
   */
  detect(text: string, options?: DetectOptions): DetectedEntity[] {
    this.lastPrivacyBlockedCount = 0;
    const maxResults = options?.maxResults ?? 3;
    const textNorm = normalizeEntityAlias(text);
    if (!textNorm) return [];

    const contextAnchors = options?.contextAnchors ?? new Set<string>();
    const results: DetectedEntity[] = [
      ...this.detectFromEntityRegistry(textNorm, contextAnchors, options),
      ...this.detectFromDocAliases(textNorm, contextAnchors),
    ];

    // ── @ prefix routing mention filter (F260 post-close regression) ──
    // @ is routing syntax (e.g. @砚砚, @codex-sol). CJK aliases matched via
    // includes() would false-positive on @-prefixed text. Filter out entities
    // whose alias ONLY appears as @-prefixed in the text. If the alias also
    // appears non-@-prefixed (e.g. "@砚砚 来一下，砚砚写得好"), keep it —
    // the standalone occurrence is a legitimate entity reference.
    const atFiltered = results.filter((r) => {
      const aliasNorm = normalizeEntityAlias(r.matchedAlias);
      const atPrefixed = `@${aliasNorm}`;
      if (!textNorm.includes(atPrefixed)) return true; // no @-mention → keep
      // Strip all @alias occurrences, then re-check if alias still matches
      const stripped = textNorm.replaceAll(atPrefixed, '');
      if (hasCJK(aliasNorm)) return stripped.includes(aliasNorm);
      // Non-CJK: use same word-boundary regex as compileAliasMatcher
      const escaped = aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pat = new RegExp(`(^|[^\\p{L}\\p{N}_@-])${escaped}(?=$|[^\\p{L}\\p{N}_@-])`, 'u');
      return pat.test(stripped);
    });

    // F263 R9: a self-describing alias that only repeats its anchor carries
    // zero information gain (for example F200 → F200 (doc)). Abstention is
    // the correct output, and filtering before sort/cap keeps noise from
    // consuming a delivery slot.
    const informative = atFiltered.filter((result) => !isSelfDescribingMatch(result));

    // Sort: confidence desc → type value weight desc → alias length desc.
    // Type weight ensures concept entities survive cap truncation over cat entities.
    informative.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (TYPE_WEIGHT[b.type] ?? 2) - (TYPE_WEIGHT[a.type] ?? 2) ||
        b.matchedAlias.length - a.matchedAlias.length,
    );

    // Cross-source dedup: if same normalized alias text matched in both
    // entity_registry and doc_aliases, keep only the higher-confidence one.
    // Since results are sorted by confidence desc, first match wins (R4-10 fix).
    const seenAliases = new Set<string>();
    const deduped = informative.filter((r) => {
      const key = normalizeEntityAlias(r.matchedAlias);
      if (seenAliases.has(key)) return false;
      seenAliases.add(key);
      return true;
    });

    return deduped.slice(0, maxResults);
  }

  /** Pass 1: match against entity_registry aliases. */
  private detectFromEntityRegistry(
    textNorm: string,
    contextAnchors: Set<string>,
    options?: DetectOptions,
  ): DetectedEntity[] {
    // Collect best alias per entity (canonical > alias by confidence).
    // Privacy gate runs once per entity to avoid overcounting (P2 fix).
    const bestByEntity = new Map<string, DetectedEntity>();
    const blocked = new Set<string>(); // entity IDs already privacy-blocked

    for (const row of this.loadEntityAliases()) {
      if (row.status !== 'active') continue;
      if (blocked.has(row.entity_id)) continue;

      const aliasNorm = normalizeEntityAlias(row.alias_norm || row.alias);
      const matcher = compileAliasMatcher(aliasNorm);
      if (!matcher?.(textNorm)) continue;

      // Privacy gate: run once per entity, block all subsequent aliases
      if (
        !bestByEntity.has(row.entity_id) &&
        !this.passesPrivacyGate(row.visibility_scope, row.provenance_json, options)
      ) {
        blocked.add(row.entity_id);
        this.lastPrivacyBlockedCount++;
        continue;
      }
      if (contextAnchors.has(row.entity_id)) continue;

      const isCanonical = normalizeEntityAlias(row.canonical_name) === aliasNorm;
      const tier: ConfidenceTier = isCanonical ? 'canonical' : 'alias';
      const confidence = CONFIDENCE_SCORES[tier];

      const existing = bestByEntity.get(row.entity_id);
      if (!existing || confidence > existing.confidence) {
        bestByEntity.set(row.entity_id, {
          entityId: row.entity_id,
          matchedAlias: row.alias,
          type: row.entity_type,
          confidence,
          sourceTable: 'entity_registry',
          provenance: this.parseProvenance(row.provenance_json),
          stance: row.stance,
          visibilityScope: row.visibility_scope,
          canonicalName: row.canonical_name,
        });
      }
    }
    return [...bestByEntity.values()];
  }

  /** Pass 2: match against doc_aliases table. */
  private detectFromDocAliases(textNorm: string, contextAnchors: Set<string>): DetectedEntity[] {
    const results: DetectedEntity[] = [];
    const seen = new Set<string>();

    for (const row of this.loadDocAliases()) {
      if (seen.has(row.doc_anchor)) continue;

      const aliasNorm = normalizeEntityAlias(row.alias_norm || row.alias);
      const matcher = compileAliasMatcher(aliasNorm);
      if (!matcher?.(textNorm)) continue;
      if (contextAnchors.has(row.doc_anchor)) continue;

      seen.add(row.doc_anchor);

      results.push({
        docAnchor: row.doc_anchor,
        matchedAlias: row.alias,
        type: 'doc',
        confidence: CONFIDENCE_SCORES['doc-title'],
        sourceTable: 'doc_aliases',
        provenance: [
          {
            source: row.source,
            ...(row.source_path
              ? { sourcePath: row.source_path }
              : /(?:^|\/)\S+\.[a-z0-9]+$/i.test(row.doc_anchor)
                ? { sourcePath: row.doc_anchor }
                : {}),
          },
        ],
      });
    }
    return results;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private loadEntityAliases(): EntityAliasRow[] {
    // Load aliases from entity_aliases table + supplement with canonical names
    // from entity_registry that aren't already in entity_aliases (R3-1 fix).
    // Same pattern as resolveQuery's loadAliases({ includeCanonical: true }).
    const aliasRows = this.db
      .prepare(
        `SELECT ea.entity_id, ea.alias, ea.alias_norm, ea.provenance_json,
                er.entity_type, er.canonical_name, er.stance, er.visibility_scope, er.status
         FROM entity_aliases ea
         JOIN entity_registry er ON er.entity_id = ea.entity_id`,
      )
      .all() as EntityAliasRow[];

    // Track which (entity_id, alias_norm) pairs we've seen from entity_aliases
    const seen = new Set<string>();
    for (const row of aliasRows) {
      seen.add(`${row.entity_id}\0${normalizeEntityAlias(row.alias_norm || row.alias)}`);
    }

    // Supplement with canonical names not already in entity_aliases
    const registryRows = this.db
      .prepare(
        'SELECT entity_id, canonical_name, provenance_json, entity_type, stance, visibility_scope, status FROM entity_registry',
      )
      .all() as Array<{
      entity_id: string;
      canonical_name: string;
      provenance_json: string;
      entity_type: string;
      stance: string;
      visibility_scope: string;
      status: string;
    }>;

    for (const er of registryRows) {
      const canonNorm = normalizeEntityAlias(er.canonical_name);
      if (!canonNorm) continue;
      const key = `${er.entity_id}\0${canonNorm}`;
      if (seen.has(key)) continue;

      aliasRows.push({
        entity_id: er.entity_id,
        alias: er.canonical_name,
        alias_norm: canonNorm,
        entity_type: er.entity_type,
        canonical_name: er.canonical_name,
        provenance_json: er.provenance_json,
        stance: er.stance,
        visibility_scope: er.visibility_scope,
        status: er.status,
      });
    }

    return aliasRows;
  }

  private loadDocAliases(): DocAliasRow[] {
    return this.db
      .prepare(
        `SELECT da.alias_norm, da.alias, da.doc_anchor, da.source, da.authority_tier,
                ed.source_path
         FROM doc_aliases da
         LEFT JOIN evidence_docs ed ON ed.anchor = da.doc_anchor`,
      )
      .all() as DocAliasRow[];
  }

  /**
   * Privacy gate: private entities only visible to their owner.
   * KD-7: private entity in non-authorized thread = zero output.
   *
   * Fail-closed: only explicit 'workspace' scope bypasses the gate.
   * The shared type is `'workspace' | \`private:${string}\``, so private
   * entities use format `private:<ownerUserId>`. We match with startsWith
   * for robustness, and default to requiring authorization for unknown scopes.
   *
   * Rules:
   *   - workspace scope → always visible
   *   - private:* scope + no caller identity → suppress
   *   - private:* scope + caller is owner → always visible (owner trumps thread)
   *   - private:* scope + caller threadId matches provenance anchor → visible
   *   - private:* scope + caller threadId != provenance anchor → suppress
   *   - unknown scope → suppress (fail-closed, KD-7: 宁哑不漏)
   */
  private passesPrivacyGate(visibilityScope: string, provenanceJson: string, options?: DetectOptions): boolean {
    if (visibilityScope === 'workspace') return true;

    // Private entity requires identity
    if (!options?.ownerUserId && !options?.threadId) return false;

    // Extract owner from `private:<owner>` format (shared EntityVisibilityScope type)
    const scopeOwner = visibilityScope.startsWith('private:') ? visibilityScope.slice('private:'.length) : undefined;

    // Owner access FIRST: owner can always see their own private entities,
    // regardless of which thread they're in (R3-3 fix).
    // Owner authorization is stronger than thread-level binding.
    if (scopeOwner && options?.ownerUserId && scopeOwner === options.ownerUserId) {
      return true;
    }

    const provenance = this.parseProvenance(provenanceJson);

    // Non-owner: check threadId against provenance anchors.
    // Private entities are bound to their origin thread — accessing from
    // a different thread by a non-owner is a privacy violation.
    if (options?.threadId) {
      const originAnchors = provenance.map((p) => p.anchor).filter(Boolean);
      if (originAnchors.length > 0) {
        return originAnchors.some((a) => a === options.threadId);
      }
    }

    // Non-owner with embedded scope owner → DENY (R2-2 fix).
    // We already checked owner match above; reaching here means mismatch.
    if (scopeOwner) {
      return false;
    }

    // Bare 'private' (no embedded owner, defense-in-depth) → any ownerUserId grants access.
    return Boolean(options?.ownerUserId);
  }

  private parseProvenance(json: string): EntityProvenance[] {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p: unknown): p is EntityProvenance =>
          typeof p === 'object' && p !== null && typeof (p as EntityProvenance).source === 'string',
      );
    } catch {
      return [];
    }
  }
}
