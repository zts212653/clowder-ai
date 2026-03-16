/**
 * F32-b Phase 3: Mention highlighting data — refreshable from API.
 *
 * Initializes from static CAT_CONFIGS (zero-load working state).
 * After useCatData fetches /api/cats, calls refreshMentionData() to rebuild
 * regex with all cats (including dynamically added ones).
 */

import { CAT_CONFIGS, escapeRegExp } from '@cat-cafe/shared';
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

// ── Owner (铲屎官) ─────────────────────────────────────────
const OWNER_ID = '__owner__';
const OWNER_COLOR = '#F5A623'; // warm gold
const OWNER_MENTIONS = ['owner', 'admin'];

// ── Module-level cache (starts from static CAT_CONFIGS) ─

const staticCats = Object.entries(CAT_CONFIGS).map(([id, c]) => ({
  id,
  mentionPatterns: [...c.mentionPatterns],
  color: { primary: c.color.primary },
}));

// Include owner as a pseudo-cat so @owner / @铲屎官 highlights gold
const withOwner = [
  ...staticCats,
  {
    id: OWNER_ID,
    mentionPatterns: OWNER_MENTIONS.map((m) => `@${m}`),
    color: { primary: OWNER_COLOR },
  },
];

let _mentionToCat = buildMentionToCat(withOwner);
let _mentionRe = buildMentionRe(_mentionToCat);
let _mentionColor = buildMentionColor(withOwner);

// ── Public API ──────────────────────────────────────────

/** Called once by useCatData after API fetch succeeds */
export function refreshMentionData(cats: CatData[]): void {
  // Always include owner alongside dynamic cats
  const ownerEntry = {
    id: OWNER_ID,
    mentionPatterns: OWNER_MENTIONS.map((m) => `@${m}`),
    color: { primary: OWNER_COLOR },
  };
  const all = [...cats, ownerEntry];
  _mentionToCat = buildMentionToCat(all);
  _mentionRe = buildMentionRe(_mentionToCat);
  _mentionColor = buildMentionColor(all);
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
