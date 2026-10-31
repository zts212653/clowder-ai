/**
 * F200 HW-5: Parse F209 eval-fixture markdown files into structured RecallFixture[].
 *
 * Each fixture file has YAML frontmatter (phase, feature_ids) and
 * markdown sections `## Fixture N: Name` containing a table of fields.
 *
 * [宪宪/Opus-46🐾]
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecallFixture {
  /** Fixture heading, e.g. "Semantic Raw Finds Non-Literal Message" */
  name: string;
  /** Search query to evaluate */
  query: string;
  /** Search scope (threads / docs / etc.) */
  scope: string | null;
  /** Search mode (semantic / lexical / hybrid) */
  mode: string | null;
  /** Search depth (raw / summary) */
  depth: string | null;
  /** Phase letter (A / B / C) */
  phase: string;
  /** Glob-like anchor pattern expected in top-k results */
  expectedAnchorPattern: string;
  /** Description of what must NOT happen */
  negativeGuard: string | null;
  /**
   * 'recall' — has an explicit search query; participates in recall@k.
   * 'drilldown' — describes post-search typed-reader contract; excluded from recall@k.
   */
  kind: 'recall' | 'drilldown';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract phase letter from YAML frontmatter. */
function extractPhase(content: string): string {
  const match = content.match(/^phase:\s*([A-Z])/m);
  return match?.[1] ?? 'unknown';
}

/** Extract the first backtick-quoted value from a string, or the raw string. */
function extractBacktickValue(raw: string): string {
  const match = raw.match(/`([^`]+)`/);
  return match?.[1] ?? raw.trim();
}

/**
 * Extract anchor pattern from a field that may contain multiple backtick spans.
 * Prefers the span containing `*` (glob pattern) over the first span, because
 * fixture anchor fields like `` `kind=session`, anchor shape `session-*` ``
 * have the descriptor first and the glob second.
 */
function extractAnchorPattern(raw: string): string {
  const matches = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (matches.length === 0) return raw.trim();
  return matches.find((m) => m.includes('*')) ?? matches[0];
}

/** Parse a markdown table row `| Key | Value |` into [key, value]. */
function parseTableRow(line: string): [string, string] | null {
  const cells = line
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  if (cells.length < 2) return null;
  return [cells[0], cells.slice(1).join(' | ')];
}

/** Normalise a field key to a canonical lowercase form. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an F209 fixture markdown file into RecallFixture[].
 *
 * Handles field-name variations across Phase A/B/C:
 * - "Query" / "Search query"
 * - "Scope" / "Search scope"
 * - "Mode" + "Depth" / "Search mode/depth" (combined, split by `/`)
 * - "Expected anchor pattern" / "Expected search result" / "Search result"
 */
export function parseF209Fixtures(filePath: string): RecallFixture[] {
  const content = readFileSync(filePath, 'utf-8');
  const phase = extractPhase(content);

  // Split on fixture headings: ## Fixture N: Title
  const fixtureSections = content.split(/^##\s+Fixture\s+\d+:\s*/m).slice(1);

  return fixtureSections.map((section) => {
    // First line of section is the fixture name (rest of heading line)
    const nameEndIdx = section.indexOf('\n');
    const name = section.slice(0, nameEndIdx).trim();

    // Parse all table rows into a key→value map
    const fields = new Map<string, string>();
    const lines = section.split('\n');
    for (const line of lines) {
      if (!line.includes('|')) continue;
      // Skip separator rows (|---|---|)
      if (/^\|[\s-|]+\|$/.test(line.trim())) continue;
      // Skip header rows (| Field | Value |)
      if (/field/i.test(line) && /value/i.test(line)) continue;
      const parsed = parseTableRow(line);
      if (parsed) {
        fields.set(normaliseKey(parsed[0]), parsed[1]);
      }
    }

    // --- Extract query ---
    const explicitQuery =
      extractBacktickValue(fields.get('query') ?? '') || extractBacktickValue(fields.get('searchquery') ?? '');
    const query = explicitQuery || name; // fallback: use fixture name

    // --- Extract scope ---
    const scope =
      extractBacktickValue(fields.get('scope') ?? '') || extractBacktickValue(fields.get('searchscope') ?? '') || null;

    // --- Extract mode and depth ---
    let mode: string | null = null;
    let depth: string | null = null;

    const modeDepthCombined = fields.get('searchmodedepth');
    if (modeDepthCombined) {
      // "Search mode/depth" field: "`semantic` / `raw`"
      const parts = modeDepthCombined.split('/').map((p) => extractBacktickValue(p));
      mode = parts[0] || null;
      depth = parts[1] || null;
    } else {
      mode = extractBacktickValue(fields.get('mode') ?? '') || null;
      depth = extractBacktickValue(fields.get('depth') ?? '') || null;
    }

    // --- Extract expected anchor pattern ---
    // P1-1 fix + cloud P2 fix: extract glob-preferring anchor from multi-backtick fields
    const anchorRaw =
      fields.get('expectedanchorpattern') ??
      fields.get('expectedsearchresult') ??
      fields.get('searchresult') ??
      fields.get('expecteddrilldown') ??
      '';
    const expectedAnchorPattern = extractAnchorPattern(anchorRaw) || name;

    // --- Extract negative guard ---
    const guardRaw = fields.get('negativeguard');
    const negativeGuard = guardRaw?.trim() || null;

    // --- Determine kind ---
    // P1-2 Round 2 fix: recall requires BOTH an explicit query AND a glob-matchable
    // anchor pattern (contains `*`). Fixtures with a query but a non-glob anchor
    // (e.g. prose descriptions like "Existing doc evidence item...") produce
    // systematic false misses in recall@k and must be classified as drilldown.
    const hasGlobAnchor = expectedAnchorPattern.includes('*');
    const kind: 'recall' | 'drilldown' = explicitQuery && hasGlobAnchor ? 'recall' : 'drilldown';

    return {
      name,
      query,
      scope,
      mode,
      depth,
      phase,
      expectedAnchorPattern,
      negativeGuard,
      kind,
    };
  });
}
