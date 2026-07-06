/**
 * F252 Phase D — Content Sanitizer for story export (AC-D2).
 *
 * Walks transcript event text and applies regex-based redaction.
 * Different from OTel TelemetryRedactor (which operates on span
 * attribute keys) — this operates on free-form event content.
 *
 * Redaction classes:
 * - Class A (credentials): API keys, tokens, passwords → [REDACTED]
 * - Class B (paths): absolute file paths, worktree paths → [PATH]
 * - Class C (env): env var assignments, config values → [CONFIG]
 * - Class D (identity): catId field + catId handles in free text → Participant N
 *
 * INV-6: Every content field in the export is sanitized — no raw
 * paths, tokens, env vars, or internal cat identifiers survive.
 */

import type { StoryAnnotation } from '@cat-cafe/shared';
import { nanoid } from 'nanoid';

// ============================================================================
// Input / output types
// ============================================================================

export interface TranscriptEvent {
  id: string;
  at: number;
  kind: string;
  content: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  catId?: string;
}

export interface SanitizedEvent {
  id: string;
  at: number;
  kind: string;
  content: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  catId?: string;
}

export interface StoryExportManifest {
  exportId: string;
  storyId: string;
  title: string;
  exportedAt: number;
  sanitizationRules: string[];
  eventCount: number;
  annotations: StoryAnnotation[];
}

export interface StoryExportPack {
  manifest: StoryExportManifest;
  events: SanitizedEvent[];
}

// ============================================================================
// Redaction rules (ordered: most specific first)
// ============================================================================

/** Class A: Credentials — API keys, tokens, JWT-like strings */
const CLASS_A_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic API keys (sk-ant-api03-...)
  { pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{8,}/g, replacement: '[REDACTED]' },
  // GitHub tokens (PAT ghp_, OAuth gho_, server ghs_, user ghu_, refresh ghr_)
  { pattern: /gh[posur]_[A-Za-z0-9]{8,}/g, replacement: '[REDACTED]' },
  // GitHub fine-grained PAT
  { pattern: /github_pat_[A-Za-z0-9_]{8,}/g, replacement: '[REDACTED]' },
  // JWT-like tokens (three base64url segments separated by dots — header always starts with eyJ)
  { pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '[REDACTED]' },
  // Generic "Bearer <token>" or "Token <token>"
  { pattern: /(?:Bearer|Token)\s+[A-Za-z0-9_-]{12,}/g, replacement: '[REDACTED]' },
  // OpenAI-style API keys (including sk-proj-… project-scoped keys)
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED]' },
];

/** Class B: File paths — absolute paths on disk */
const CLASS_B_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // macOS/Linux/container/CI absolute paths
  {
    pattern:
      /\/(?:Users|home|tmp|var|private|workspace|root|etc|opt|app|usr|run|srv|mnt|snap|proc|sys|boot)[/][^\s"'`)\]}>]+/g,
    replacement: '[PATH]',
  },
];

/** Class C: Environment / config — KEY=value for sensitive keys */
const CLASS_C_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Database URLs (postgres://, mysql://, redis://, mongodb://)
  { pattern: /(?:postgres|mysql|redis|mongodb|amqp)s?:\/\/[^\s"'`)\]}>]+/g, replacement: '[CONFIG]' },
  // Sensitive env var assignments: KEY=value
  {
    pattern:
      /(?:(?:ANTHROPIC|OPENAI|GOOGLE|AWS|AZURE|GITHUB|REDIS|DATABASE|SECRET|PRIVATE|API|AUTH|CALLBACK)[_A-Z]*(?:_KEY|_TOKEN|_SECRET|_URL|_PASSWORD|_CREDENTIAL))\s*=\s*\S+/g,
    replacement: '[CONFIG]',
  },
  // SECRET_KEY=value, PASSWORD=value (shorter names)
  { pattern: /(?:SECRET_KEY|PASSWORD|CREDENTIAL|DB_PASSWORD|DB_URL)\s*=\s*\S+/g, replacement: '[CONFIG]' },
];

// ============================================================================
// Sanitization functions
// ============================================================================

/** Apply all redaction rules to a single string. */
function redactString(text: string): string {
  // Defense-in-depth: Claude API content blocks may be arrays (content blocks)
  // or objects. Coerce to string to prevent .replace() TypeError at runtime.
  if (typeof text !== 'string') {
    text = JSON.stringify(text);
  }
  let result = text;

  // Class A first (most specific — prevent partial matches with Class C)
  for (const rule of CLASS_A_PATTERNS) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  // Class C before B (env vars may contain paths — redact the whole assignment)
  for (const rule of CLASS_C_PATTERNS) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  // Class B last
  for (const rule of CLASS_B_PATTERNS) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  return result;
}

/** Escape regex special characters. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Class D: Identity redaction (catId field + text-level handles/aliases)
// ============================================================================

/**
 * Cat identity aliases: catId → list of alternate identifiers
 * (displayName, nickname, mention handles without @, etc.)
 * Built from cat-config.json breeds via buildCatIdentityAliases().
 */
export type CatIdentityAliases = Map<string, string[]>;

/**
 * Build identity aliases from breeds config (cat-config.json `.breeds`).
 * Pure function — caller provides the breeds data.
 *
 * Each breed/variant catId maps to its displayName, nickname, and
 * mention patterns (with leading @ stripped). The map is consumed by
 * sanitizeStoryExport() to expand the redaction set beyond raw catIds.
 */
export function buildCatIdentityAliases(
  breeds: Array<{
    catId: string;
    name?: string;
    displayName?: string;
    nickname?: string | null;
    mentionPatterns?: string[];
    variants?: Array<{
      catId?: string;
      // clowder-ai#1090: variant-scoped identity overrides — must feed redaction
      // set so a renamed multi-variant member doesn't leak in public story exports.
      name?: string;
      nickname?: string | null;
      displayName?: string;
      variantLabel?: string;
      mentionPatterns?: string[];
    }>;
  }>,
  coCreator?: {
    name?: string;
    aliases?: string[];
    mentionPatterns?: string[];
  },
): CatIdentityAliases {
  const aliases = new Map<string, string[]>();

  for (const breed of breeds) {
    const set = new Set<string>();
    if (breed.name) set.add(breed.name);
    if (breed.displayName && breed.displayName !== breed.name) set.add(breed.displayName);
    if (breed.nickname) set.add(breed.nickname);
    for (const p of breed.mentionPatterns ?? []) {
      const clean = p.replace(/^@/, '');
      if (clean !== breed.catId) set.add(clean);
    }
    // Breed aliases finalized AFTER variant loop so default-variant identity
    // overrides (clowder-ai#1090) can be merged into the breed alias set —
    // default variants inherit breed.catId at runtime, so their persisted
    // name / nickname belong to the same alias entry.

    // Variant aliases: skip identity that matches breed name/displayName —
    // the breed catId owns the shared breed name (e.g. '布偶猫' belongs to
    // opus, not sonnet/opus-47/fable-5). Prevents first-wins collision where
    // the breed name gets bound to whichever variant appears first in events.
    // Applies to variant.name (clowder-ai#1090) and variant.displayName alike.
    const breedNames = new Set([breed.name, breed.displayName].filter(Boolean));
    for (const v of breed.variants ?? []) {
      // clowder-ai#1090: default variants typically have no explicit v.catId
      // (they inherit breed.catId, e.g. `opus-default` id). Resolve variant
      // catId with the same `variant.catId ?? breed.catId` rule the runtime
      // uses, so default-variant identity overrides written by
      // `updateRuntimeCat` are still folded into the redaction map.
      const variantCatId = v.catId ?? breed.catId;
      const isDefaultVariant = variantCatId === breed.catId;
      // Default variant overrides merge into the breed alias set (shared catId).
      // Non-default variants get an independent alias entry.
      const target = isDefaultVariant ? set : new Set<string>();

      // clowder-ai#1090: include variant-scoped identity so renamed members
      // don't leak into public story exports.
      if (v.name && !breedNames.has(v.name)) target.add(v.name);
      if (v.nickname) target.add(v.nickname);
      if (v.displayName && !breedNames.has(v.displayName)) target.add(v.displayName);
      if (v.variantLabel) target.add(v.variantLabel);
      for (const p of v.mentionPatterns ?? []) {
        const clean = p.replace(/^@/, '');
        if (clean !== variantCatId) target.add(clean);
      }

      if (!isDefaultVariant && target.size > 0) {
        aliases.set(variantCatId, [...target]);
      }
      // Default variant path: mutations already flowed into `set` and are
      // finalized in the breed-level `aliases.set` below.
    }

    // Finalize breed aliases after default-variant merge.
    if (set.size > 0) aliases.set(breed.catId, [...set]);
  }

  // coCreator identity (You / L.S. / Lysander etc.)
  if (coCreator) {
    const coSet = new Set<string>();
    if (coCreator.name) coSet.add(coCreator.name);
    for (const alias of coCreator.aliases ?? []) coSet.add(alias);
    for (const p of coCreator.mentionPatterns ?? []) coSet.add(p.replace(/^@/, ''));
    if (coSet.size > 0) aliases.set('__coCreator__', [...coSet]);
  }

  return aliases;
}

/**
 * Class D text-level: replace cat identifiers (catIds + aliases) in
 * free-form text with their anonymous Participant N labels.
 * Applied after Class A/B/C redaction to avoid collisions.
 *
 * Key behaviors:
 * - Sorted by key length DESC to prevent partial match corruption
 *   (e.g., 'opus-47' processed before 'opus')
 * - Uses negative lookahead/lookbehind `(?<![a-zA-Z0-9_-])..(?![a-zA-Z0-9_-])`
 *   instead of `\b` — treats hyphens as identifier chars (prevents
 *   `\bopus\b` matching inside `opus-47`)
 * - CJK identifiers (宪宪, 砚砚, etc.) use the same lookaround which
 *   works because CJK chars are not in [a-zA-Z0-9_-]
 */
/**
 * Well-known common English words that also serve as Clowder AI identifiers.
 * These appear in everyday prose (e.g. "a sonnet about cats", "a spark of
 * inspiration", "a golden opportunity") and would cause false-positive
 * redaction if matched standalone. Phase 2 only detects/redacts these via
 * @mention form.
 *
 * Lookup is case-insensitive — both "sonnet" (catId) and "Sonnet"
 * (variantLabel) are covered by the same entry.
 *
 * Criteria for inclusion: the word commonly appears in English prose
 * without referring to a Clowder AI identity. Proper nouns that are
 * distinctive enough to safely redact (e.g. "Gemini", "You",
 * "Lysander") are excluded even if short.
 */
const AMBIGUOUS_COMMON_WORDS: ReadonlySet<string> = new Set([
  'spark', // noun/verb — "a spark of inspiration"
  'dare', // verb — "I dare you", "truth or dare"
  'opus', // noun — "his latest opus", "magnum opus"
  'fable', // noun — "a fable about cats"
  'codex', // noun — "the ancient codex"
  'sonnet', // noun — "a sonnet about love"
  'golden', // adjective — "golden opportunity", "golden age"
  'maine', // geographic — "we drove through Maine"
]);

/**
 * Is this identifier an ambiguous common English word?
 * Applied per-identifier (both catIds AND aliases) — not just at the
 * catId level. This prevents common-word variantLabels (e.g. "Sonnet"),
 * breed nicknames (e.g. "golden"), and state names (e.g. "maine") from
 * corrupting prose.
 */
function isAmbiguousIdentifier(id: string): boolean {
  return AMBIGUOUS_COMMON_WORDS.has(id.toLowerCase());
}

function redactCatIdentifiers(text: string, catNameMap: Map<string, string>, mentionOnlyKeys?: Set<string>): string {
  let result = text;
  // Sort by key length descending — longer keys first to prevent
  // shorter key corrupting longer match (opus-47 before opus)
  const sorted = [...catNameMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [identifier, label] of sorted) {
    const escaped = escapeRegex(identifier);
    // @mention form: @opus → @Participant 1
    // Negative lookahead prevents @opus matching in @opus-47
    result = result.replace(new RegExp(`@${escaped}(?![a-zA-Z0-9_-])`, 'gi'), `@${label}`);
    // Standalone: negative lookbehind + lookahead for identifier-continuation chars
    // Case-insensitive: Codex/OPUS/Ragdoll at sentence start must match lowercase catIds
    // Skip standalone for mention-only keys (ambiguous common words in Phase 2
    // that could appear in ordinary prose — "A spark of inspiration")
    if (!mentionOnlyKeys?.has(identifier)) {
      result = result.replace(new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'gi'), label);
    }
  }
  return result;
}

/**
 * Sanitize a single transcript event. Pure function.
 * @param catNameMap Optional Class D mapping: internal catId → anonymous label.
 *   When provided, catIds are anonymized. When omitted, catId passes through
 *   (standalone use — not for public export).
 * @param mentionOnlyKeys Optional set of identifiers that should only be
 *   redacted in @mention form, not standalone (ambiguous common words from
 *   Phase 2 non-author roster entries).
 */
export function sanitizeEventContent(
  event: TranscriptEvent,
  catNameMap?: Map<string, string>,
  mentionOnlyKeys?: Set<string>,
): SanitizedEvent {
  let resolvedCatId = event.catId;
  if (catNameMap && event.catId !== undefined) {
    resolvedCatId = catNameMap.get(event.catId) ?? '[Participant]';
  }

  // Class A/B/C + optional Class D text-level (when exporting with catNameMap)
  const sanitize =
    catNameMap && catNameMap.size > 0
      ? (text: string) => redactCatIdentifiers(redactString(text), catNameMap, mentionOnlyKeys)
      : redactString;

  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    content: sanitize(event.content),
    ...(event.toolName !== undefined && { toolName: event.toolName }),
    ...(event.toolArgs !== undefined && { toolArgs: sanitize(event.toolArgs) }),
    ...(event.toolResult !== undefined && { toolResult: sanitize(event.toolResult) }),
    ...(resolvedCatId !== undefined && { catId: resolvedCatId }),
  };
}

/**
 * Produce a sanitized export pack from raw events + annotations.
 * Pure function — no IO.
 *
 * Class D (identity): internal catIds are anonymized to "Participant N"
 * labels, ordered by first appearance. Spec requirement:
 * "平行猫内部名字（保留公开猫名）" — internal cat names must not leak.
 */
export function sanitizeStoryExport(
  storyId: string,
  title: string,
  events: TranscriptEvent[],
  annotations: StoryAnnotation[],
  catIdentityAliases?: CatIdentityAliases,
): StoryExportPack {
  // Class D: build deterministic catId → anonymous label mapping
  // Phase 1: map event authors (deterministic order by first appearance)
  const catNameMap = new Map<string, string>();
  let participantNum = 0;
  for (const event of events) {
    if (event.catId && !catNameMap.has(event.catId)) {
      participantNum++;
      const label = `Participant ${participantNum}`;
      catNameMap.set(event.catId, label);
      // Expand aliases (displayName, nickname, mention handles) to same label
      const aliases = catIdentityAliases?.get(event.catId);
      if (aliases) {
        for (const alias of aliases) {
          if (!catNameMap.has(alias)) catNameMap.set(alias, label);
        }
      }
    }
  }
  // Phase 2: non-participating roster entries — only include identities
  // actually referenced in any sanitized text surface (events + title +
  // annotations). This keeps participant numbers dense (no gaps revealing
  // roster size) and avoids pre-allocating labels for identities that
  // never appear in the exported story.
  //
  // Detection uses boundary-aware regex to avoid false positives from
  // substring matching (e.g. "declare" containing "dare").
  //
  // Ambiguous identifiers (pure ASCII alpha ≤ 7 chars, case-insensitive,
  // e.g. "spark", "sonnet", "golden", "Sonnet") require @mention form
  // for detection — standalone common words in English prose should not
  // trigger identity redaction. Distinctive identifiers (CJK, hyphenated,
  // numeric, > 7 chars) use both @mention and standalone detection.
  // Ambiguity is checked per-identifier (both catIds and aliases).
  //
  // mentionOnlyKeys: ambiguous Phase 2 identifiers are tracked here so
  // redactCatIdentifiers() only replaces their @mention form, leaving
  // standalone occurrences in prose untouched (e.g. "A sonnet about cats"
  // survives even when @sonnet is redacted).
  const mentionOnlyKeys = new Set<string>();
  if (catIdentityAliases) {
    const textParts = events.map((e) => [e.content, e.toolArgs, e.toolResult].filter(Boolean).join(' '));
    textParts.push(title);
    for (const a of annotations) textParts.push(a.content);
    const allText = textParts.join(' ');
    for (const [catId, aliases] of catIdentityAliases) {
      if (catNameMap.has(catId)) continue; // already numbered in Phase 1
      // Detection helpers — boundary-aware regex matching
      const hasMentionMatch = (id: string): boolean => {
        const escaped = escapeRegex(id);
        return new RegExp(`@${escaped}(?![a-zA-Z0-9_-])`, 'i').test(allText);
      };
      const hasStandaloneMatch = (id: string): boolean => {
        const escaped = escapeRegex(id);
        return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'i').test(allText);
      };
      // Per-identifier ambiguity: short pure-alpha words like "spark",
      // "sonnet", "golden" require @mention for detection — standalone
      // common words in English prose must not trigger identity detection.
      // Applied to each identifier independently (catIds AND aliases).
      const hasBoundaryMatch = (id: string): boolean => {
        if (isAmbiguousIdentifier(id)) return hasMentionMatch(id);
        return hasMentionMatch(id) || hasStandaloneMatch(id);
      };
      const isReferenced = hasBoundaryMatch(catId) || aliases.some(hasBoundaryMatch);
      if (!isReferenced) continue; // never mentioned — skip
      participantNum++;
      const label = `Participant ${participantNum}`;
      catNameMap.set(catId, label);
      if (isAmbiguousIdentifier(catId)) mentionOnlyKeys.add(catId);
      for (const alias of aliases) {
        if (!catNameMap.has(alias)) catNameMap.set(alias, label);
        // Each alias checked independently — common-word variantLabels
        // (e.g. "Sonnet"), breed nicknames, etc. get mention-only treatment
        if (isAmbiguousIdentifier(alias)) mentionOnlyKeys.add(alias);
      }
    }
  }

  const sanitizedEvents = events.map((e) => sanitizeEventContent(e, catNameMap, mentionOnlyKeys));

  const appliedRules = ['class-a-credentials', 'class-b-paths', 'class-c-env', 'class-d-identity'];

  // Export-level sanitizer: Class A/B/C + Class D text-level for cat handles
  const sanitizeForExport =
    catNameMap.size > 0
      ? (text: string) => redactCatIdentifiers(redactString(text), catNameMap, mentionOnlyKeys)
      : redactString;

  // Sanitize annotations — user-authored free text may contain secrets
  // and cat handles (P1-2: unauthenticated /public route = real leak path)
  const sanitizedAnnotations = annotations.map((a) => ({
    ...a,
    content: sanitizeForExport(a.content),
  }));

  const manifest: StoryExportManifest = {
    exportId: nanoid(),
    storyId,
    title: sanitizeForExport(title), // Audit: title + cat names may leak
    exportedAt: Date.now(),
    sanitizationRules: appliedRules,
    eventCount: sanitizedEvents.length,
    annotations: sanitizedAnnotations,
  };

  return { manifest, events: sanitizedEvents };
}
