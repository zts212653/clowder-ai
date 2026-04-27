/**
 * F32-b Phase 3: Mention highlighting data — refreshable from API.
 *
 * Starts empty; useCatData calls refreshMentionData() after /api/cats fetch
 * to populate regex with all cats from the runtime catalog.
 */

import { escapeRegExp } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';

// ── Internal builders ───────────────────────────────────

function buildMentionToCat(cats: Array<{ id: string; mentionPatterns: string[] }>): Record<string, string> {
  return Object.fromEntries(
    cats.flatMap((cat) => cat.mentionPatterns.map((p) => [p.replace(/^@/, '').toLowerCase(), cat.id])),
  );
}

function buildMentionRe(toCat: Record<string, string>): RegExp {
  const aliases = Object.keys(toCat).sort((a, b) => b.length - a.length);
  if (aliases.length === 0) return /(?!)/g; // never-match fallback
  const pattern = aliases.map(escapeRegExp).join('|');
  // Boundary chars aligned with backend AgentRouter.parseMentions
  return new RegExp(`@(${pattern})(?=$|\\s|[,.:;!?()\\[\\]{}<>，。！？、：；（）【】《》「」『』〈〉])`, 'gi');
}

function buildMentionColor(cats: Array<{ id: string; color: { primary: string } }>): Record<string, string> {
  return Object.fromEntries(cats.map((cat) => [cat.id, cat.color.primary]));
}

// ── Co-Creator (铲屎官) ───────────────────────────────────
const CO_CREATOR_ID = '__co-creator__';
const CO_CREATOR_COLOR = '#F5A623'; // warm gold
const DEFAULT_CO_CREATOR_MENTION_PATTERNS = ['@co-creator', '@铲屎官'];

// ── Module-level cache (populated by refreshMentionData after /api/cats fetch) ─

// Include co-creator as pseudo-cat so @铲屎官 highlights gold
let _cats: Array<{ id: string; mentionPatterns: string[]; color: { primary: string } }> = [];
let _coCreatorMentionPatterns = [...DEFAULT_CO_CREATOR_MENTION_PATTERNS];
let _mentionToCat = buildMentionToCat([]);
let _mentionRe = buildMentionRe(_mentionToCat);
let _mentionColor = buildMentionColor([]);

function normalizeCoCreatorMentionPatterns(mentionPatterns: readonly string[]): string[] {
  const normalized = mentionPatterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => (pattern.startsWith('@') ? pattern : `@${pattern}`));
  const unique = new Set(DEFAULT_CO_CREATOR_MENTION_PATTERNS);
  for (const pattern of normalized) unique.add(pattern);
  return [...unique];
}

function rebuildMentionCache(): void {
  const ownerEntry = {
    id: CO_CREATOR_ID,
    mentionPatterns: _coCreatorMentionPatterns,
    color: { primary: CO_CREATOR_COLOR },
  };
  const all = [..._cats, ownerEntry];
  _mentionToCat = buildMentionToCat(all);
  _mentionRe = buildMentionRe(_mentionToCat);
  _mentionColor = buildMentionColor(all);
}

rebuildMentionCache();

// ── Public API ──────────────────────────────────────────

/** Called once by useCatData after API fetch succeeds.
 *  Filters out disabled members (roster.available === false) so they don't highlight. */
export function refreshMentionData(cats: CatData[]): void {
  _cats = cats.filter((cat) => cat.roster?.available !== false);
  rebuildMentionCache();
}

export function refreshCoCreatorMentionData(mentionPatterns: readonly string[]): void {
  _coCreatorMentionPatterns = normalizeCoCreatorMentionPatterns(mentionPatterns);
  rebuildMentionCache();
}

/** Get the current mention regex (refreshed after API load) */
export function getMentionRe(): RegExp {
  return _mentionRe;
}

/** Map mention alias (lowercase, no @) → catId */
export function getMentionToCat(): Record<string, string> {
  return _mentionToCat;
}

/** Map catId → primary color hex (e.g. "#9B7EBD") */
export function getMentionColor(): Record<string, string> {
  return _mentionColor;
}

export function resetMentionDataForTest(): void {
  _cats = [];
  _coCreatorMentionPatterns = [...DEFAULT_CO_CREATOR_MENTION_PATTERNS];
  rebuildMentionCache();
}
