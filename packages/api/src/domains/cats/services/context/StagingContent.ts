/**
 * L0 Staging Protocol — 件套 ④ impl (PR-B-impl, ADR-038)
 *
 * Loads `cat-cafe-skills/refs/l0-staging-content.md` + parses YAML frontmatter
 * manifest. Renders staging content as a system-prompt prepend for each cat
 * invocation. Tracks double conservation invariants:
 *
 *   L0 tokens ≤ HARD_CAP_L0 (6000, enforced by compile-system-prompt-l0.test.mjs)
 *   AND
 *   staging tokens ≤ HARD_CAP_STAGING (2000, enforced by this module's guard test)
 *
 * Critical (per 砚砚 R1 P2 in PR #2221): staging content goes into the runtime
 * user-message systemPrompt path (SystemPromptBuilder), NOT compiled into the
 * native L0 (compile-system-prompt-l0.mjs). It does NOT count against the
 * 6,000-token L0 cap.
 *
 * Demote/promote workflow (ADR-038) is manual review-driven in v1 (no automation
 * yet — see OQ #3).
 *
 * Known limitations (per ADR-038 「已知限制」, fable-5 P1-2):
 * - v1 触发率 telemetry not implemented (uses calendar window heuristic)
 * - presence-normalized 触发率 deferred to v2
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatId } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
// staging content lives in cat-cafe-skills/refs/ — package-relative path
const STAGING_CONTENT_PATH = resolve(__dirname, '../../../../../../../cat-cafe-skills/refs/l0-staging-content.md');

const EMPTY_STAGING_CONTENT: ParsedStagingContent = {
  manifest: {
    staging_version: 1,
    schema_doc: '',
    hard_cap_tokens: 2000,
    soft_margin_tokens: 200,
    items: [],
  },
  body: '',
};

interface FirstPrinciplesCheck {
  single_round_complete: boolean;
  compress_gap_harmful: boolean;
  referenced_by_l0: boolean;
  verdict: string;
}

export interface StagingItem {
  id: string;
  title: string;
  /** "shared" or a breed name (ragdoll / maine-coon / siamese / golden-chinchilla) */
  family: string;
  source: string;
  added_at: string;
  estimated_tokens: number;
  first_principles_check: FirstPrinciplesCheck;
  /**
   * Trigger-rate evidence (ADR-038 §Demote 判据 AND 而非 OR, cloud R1 P1 #2239).
   * Required for demote-from-L0 path; can be "not-applicable-investment-from-source-thread"
   * for items that arrived via direct staging investment (e.g. wipers-clause).
   */
  trigger_rate_method?: string;
  trigger_rate_window?: string;
  trigger_rate_note?: string;
  cvo_signoff?: string;
}

export interface StagingManifest {
  staging_version: number;
  schema_doc: string;
  hard_cap_tokens: number;
  soft_margin_tokens: number;
  items: readonly StagingItem[];
}

interface ParsedStagingContent {
  manifest: StagingManifest;
  /** Body markdown (everything after the closing `---`). Used as the prepend text. */
  body: string;
}

let _cachedContent: ParsedStagingContent | null = null;

/**
 * Parse the markdown file's YAML frontmatter (between leading `---` markers).
 *
 * Kept intentionally simple — only supports the manifest schema in
 * l0-staging-content.md. For richer YAML, swap in a real parser later.
 */
function parseFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      '[L0 staging] frontmatter not found — l0-staging-content.md must begin with `---` frontmatter block',
    );
  }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
}

/** Minimal YAML parser for our manifest schema (no general YAML support). */
function parseManifest(yaml: string): StagingManifest {
  const lines = yaml.split('\n');
  const top: Record<string, unknown> = {};
  const items: StagingItem[] = [];
  let mode: 'top' | 'item' | 'check' = 'top';
  let currentItem: Partial<StagingItem> & { first_principles_check?: Partial<FirstPrinciplesCheck> } = {};
  let currentCheck: Partial<FirstPrinciplesCheck> = {};

  const flushItem = () => {
    if (currentItem.id) {
      if (Object.keys(currentCheck).length > 0) {
        currentItem.first_principles_check = currentCheck as FirstPrinciplesCheck;
      }
      items.push(currentItem as StagingItem);
    }
    currentItem = {};
    currentCheck = {};
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    // Top-level scalar field: `key: value`
    if (mode === 'top' && /^[a-z_0-9]+:/.test(line)) {
      const m = line.match(/^([a-z_0-9]+):\s*(.*)$/);
      if (m) {
        const [, key, value] = m;
        if (key === 'items') {
          mode = 'item';
        } else if (key && value !== undefined) {
          // Coerce numbers
          const num = Number(value);
          top[key] = Number.isNaN(num) || value.trim() === '' ? value.trim() : num;
        }
      }
      continue;
    }
    // Item start: `  - id: foo`
    if (line.startsWith('  - ')) {
      flushItem();
      mode = 'item';
      const m = line.match(/^\s*-\s*([a-z_0-9]+):\s*(.*)$/);
      if (m) {
        const [, key, value] = m;
        if (key === 'id' && value) currentItem.id = value.trim();
      }
      continue;
    }
    // Item field: `    key: value`
    if (mode === 'item' && /^\s{4}[a-z_0-9]+:/.test(line) && !line.startsWith('      ')) {
      const m = line.match(/^\s{4}([a-z_0-9]+):\s*(.*)$/);
      if (m) {
        const [, key, value] = m;
        if (key === 'first_principles_check') {
          mode = 'check';
        } else if (key && value !== undefined) {
          const num = Number(value);
          const coerced = Number.isNaN(num) || value.trim() === '' ? value.trim() : num;
          (currentItem as Record<string, unknown>)[key] = coerced;
        }
      }
      continue;
    }
    // first_principles_check sub-field: `      key: value`
    if (mode === 'check' && line.startsWith('      ')) {
      const m = line.match(/^\s{6}([a-z_0-9]+):\s*(.*)$/);
      if (m) {
        const [, key, value] = m;
        if (key && value !== undefined) {
          const v = value.trim();
          if (v === 'true') (currentCheck as Record<string, unknown>)[key] = true;
          else if (v === 'false') (currentCheck as Record<string, unknown>)[key] = false;
          else (currentCheck as Record<string, unknown>)[key] = v;
        }
      }
      continue;
    }
    // Indent drops back to item field after a check block
    if (mode === 'check' && /^\s{4}[a-z_0-9]+:/.test(line)) {
      mode = 'item';
      const m = line.match(/^\s{4}([a-z_0-9]+):\s*(.*)$/);
      if (m) {
        const [, key, value] = m;
        if (key && value !== undefined) {
          (currentItem as Record<string, unknown>)[key] = value.trim();
        }
      }
    }
  }
  flushItem();

  return {
    staging_version: (top.staging_version as number) ?? 1,
    schema_doc: (top.schema_doc as string) ?? '',
    hard_cap_tokens: (top.hard_cap_tokens as number) ?? 2000,
    soft_margin_tokens: (top.soft_margin_tokens as number) ?? 200,
    items,
  };
}

function loadStagingContent(): ParsedStagingContent {
  if (_cachedContent) return _cachedContent;
  let raw: string;
  try {
    raw = readFileSync(STAGING_CONTENT_PATH, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      _cachedContent = EMPTY_STAGING_CONTENT;
      return _cachedContent;
    }
    throw error;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const manifest = parseManifest(frontmatter);
  _cachedContent = { manifest, body };
  return _cachedContent;
}

/**
 * Test-only: reset cache so tests can re-load after mutating the file or
 * stubbing the path. NOT exported from index.ts (per cells/skill discipline).
 */
export function _resetStagingCache(): void {
  _cachedContent = null;
}

/**
 * Returns staging content prepend text for `catId`, or empty string if no
 * applicable staging items exist for the cat's family.
 *
 * - `family: shared` items apply to all cats.
 * - Other family values apply only to matching breed (currently breed → family
 *   mapping comes from cat-config; family-specific staging lands when needed).
 */
export function buildStagingPrepend(catId: CatId): string {
  // Unknown-cat防线: don't fabricate staging for catId not in registry.
  // (砚砚 R2 #2237: this防线 was at buildLiveStaticIdentity level, but it
  // accidentally swallowed staging for native L0 + no-pack cats whose
  // baseIdentity is legitimately empty. Moved here.)
  const config = catRegistry.tryGet(catId as string)?.config;
  if (!config) return '';
  const { manifest, body } = loadStagingContent();
  // For v1: only shared items are wired. Family-specific staging waits for
  // first family-specific demote case (per ADR-038 OQ #3 — staying manual).
  const sharedItems = manifest.items.filter((item) => item.family === 'shared');
  if (sharedItems.length === 0) return '';
  // Body is rendered as-is; manifest is the source-of-truth for budget/audit.
  // Future iteration: render per-cat-family slices when family-specific items appear.
  const header = `> L0 Staging Layer (ADR-038, ${sharedItems.length} shared items, ~${sharedItems.reduce(
    (sum, it) => sum + it.estimated_tokens,
    0,
  )} tokens — outside L0 ${manifest.hard_cap_tokens}-cap)`;
  return `${header}\n\n${body.trim()}`;
}

/**
 * Returns the parsed manifest for guard tests / token budget invariants.
 * Hard invariant (per ADR-038 双层守恒):
 *   sum(items.estimated_tokens) ≤ manifest.hard_cap_tokens
 */
export function loadStagingManifest(): StagingManifest {
  return loadStagingContent().manifest;
}
