import { basename, relative } from 'node:path';
import { inferKindFromPath } from '@cat-cafe/shared/scanner-discovery-pure';
import type { EvidenceKind, EvidenceStatus, ScannedEvidence } from './interfaces.js';
import { isMarkdownSeparator, stripYamlFrontmatter } from './MarkdownPassageIndexer.js';

const VALID_EVIDENCE_STATUSES = new Set<EvidenceStatus>([
  'active',
  'done',
  'archived',
  'review',
  'invalidated',
  'superseded',
  'drifted',
  'stale',
  'historical',
  'retired',
]);
const EMPTY_FRONTMATTER_REFS = new Set(['null', '~', '[]']);

interface ParsedFrontmatterEntry {
  key: string;
  value: unknown;
  nextIndex: number;
}

export function parseSvgAssetToEvidence(
  filePath: string,
  projectRoot: string,
  content: string,
): ScannedEvidence | null {
  const text = extractSvgTextContent(content);
  if (!text) return null;

  const sourcePath = relative(projectRoot, filePath);
  const title = extractSvgTitle(content) ?? basename(filePath, '.svg').replace(/[-_]+/g, ' ');
  const summary = text.length > 3000 ? `${text.slice(0, 2997)}...` : text;

  return {
    item: {
      anchor: `doc:${sourcePath.replace(/\.svg$/, '')}`,
      kind: inferKindFromPath(filePath),
      status: 'active',
      title,
      summary,
      sourcePath,
      updatedAt: new Date().toISOString(),
    },
    provenance: { tier: 'derived', source: sourcePath },
    rawContent: content,
    passages: [],
  };
}

function extractSvgTitle(content: string): string | null {
  const match = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1] ? normalizeSvgText(match[1]) : '';
  return title || null;
}

function extractSvgTextContent(content: string): string {
  const cleaned = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const text = normalizeSvgText(value ?? '');
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };

  for (const tag of ['title', 'desc', 'tspan']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    for (const match of cleaned.matchAll(re)) push(match[1]);
  }

  for (const match of cleaned.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) {
    const whole = match[0] ?? '';
    if (/<tspan\b/i.test(whole)) continue;
    push(match[1]);
  }

  for (const match of cleaned.matchAll(/\b(?:aria-label|data-label|inkscape:label)=["']([^"']+)["']/gi)) {
    push(match[1]);
  }

  return parts.join(' ');
}

function normalizeSvgText(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    return XML_NAMED_ENTITIES[lower] ?? decodeNumericXmlEntity(lower, entity);
  });
}

function decodeNumericXmlEntity(body: string, fallback: string): string {
  const code = body.startsWith('#x')
    ? Number.parseInt(body.slice(2), 16)
    : body.startsWith('#')
      ? Number.parseInt(body.slice(1), 10)
      : Number.NaN;
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
  return String.fromCodePoint(code);
}

export function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const entry = parseFrontmatterEntry(lines, i);
    if (!entry) continue;
    result[entry.key] = entry.value;
    i = entry.nextIndex - 1;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function parseFrontmatterEntry(lines: string[], index: number): ParsedFrontmatterEntry | null {
  const line = lines[index];
  if (line === undefined) return null;
  const kv = line.match(/^(\w+):(?:\s*(.*))?$/);
  if (!kv) return null;
  const [, key, rawVal] = kv;
  if (!key) return null;

  const scalar = rawVal ? rawVal.trim() : '';
  if (!scalar) {
    const blockList = readFrontmatterBlockList(lines, index);
    if (blockList.items.length === 0) return null;
    return { key, value: blockList.items, nextIndex: blockList.nextIndex };
  }

  const inlineList = parseFrontmatterInlineList(scalar);
  if (inlineList) return { key, value: inlineList, nextIndex: index + 1 };
  return { key, value: scalar, nextIndex: index + 1 };
}

function readFrontmatterBlockList(lines: string[], index: number): { items: string[]; nextIndex: number } {
  const items: string[] = [];
  let nextIndex = index + 1;
  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    if (line === undefined) break;
    const listMatch = line.match(/^\s+-\s*(.*)$/);
    if (!listMatch) break;
    const rawItem = listMatch[1];
    if (rawItem !== undefined) {
      const item = normalizeFrontmatterScalar(rawItem);
      if (item) items.push(item);
    }
    nextIndex += 1;
  }
  return { items, nextIndex };
}

function parseFrontmatterInlineList(value: string): string[] | null {
  const arrMatch = stripYamlInlineComment(value)
    .trim()
    .match(/^\[(.*)]$/);
  if (!arrMatch) return null;
  const items = arrMatch[1];
  if (items === undefined) return [];
  return items
    .split(',')
    .map(normalizeFrontmatterScalar)
    .filter((item) => item.length > 0);
}

/**
 * Single source of truth: is this the canonical, top-level feature spec path?
 * Used to gate whether feature_ids can serve as anchor vs. keywords-only.
 *
 * Feature support material under `features/assets/**` references a feature but
 * must not compete with `features/Fxxx-*.md` for the canonical Fxxx anchor.
 * Without sourcePath, returns false (conservative).
 */
export function isFeatureDocPath(sourcePath: string | undefined): boolean {
  if (!sourcePath) return false;
  const normalized = sourcePath.replace(/\\/g, '/');
  return /(?:^|\/)features\/[^/]+\.md$/i.test(normalized);
}

/**
 * Extract anchor from frontmatter.
 *
 * `sourcePath` gates the `feature_ids` → anchor fallback: only canonical docs
 * directly under `features/` may claim a feature anchor.
 * Non-feature docs with `feature_ids` should use path-based anchors and have
 * their feature_ids promoted to keywords/edges instead.
 *
 * Why: non-feature docs (architecture/, decisions/) referencing features via
 * `feature_ids` frontmatter were stealing the feature anchor, causing collision
 * with real feature docs and turning both into ghosts (P1 bug).
 */
export function extractAnchor(fm: Record<string, unknown>, sourcePath?: string): string | null {
  const anchor = fm.anchor;
  if (typeof anchor === 'string') return anchor;

  if (isFeatureDocPath(sourcePath)) {
    const featureIds = fm.feature_ids;
    if (Array.isArray(featureIds) && featureIds.length > 0) return featureIds[0] as string;
  }

  const decisionId = fm.decision_id;
  if (typeof decisionId === 'string') return decisionId;
  const planId = fm.plan_id;
  if (typeof planId === 'string') return planId;
  return null;
}

/**
 * Extract feature_ids from frontmatter as keyword strings for non-feature docs.
 * Feature docs use feature_ids as anchor; non-feature docs get them as keywords
 * for discoverability.
 */
export function extractFeatureIdKeywords(fm: Record<string, unknown> | null, sourcePath: string): string[] {
  if (!fm || isFeatureDocPath(sourcePath)) return [];
  const featureIds = fm.feature_ids;
  if (!Array.isArray(featureIds)) return [];
  return featureIds.filter((id): id is string => typeof id === 'string');
}

export function extractEvidenceStatus(fm: Record<string, unknown> | null): EvidenceStatus {
  const raw = fm?.status;
  if (typeof raw !== 'string') return 'active';
  const status = normalizeFrontmatterScalar(raw);
  return VALID_EVIDENCE_STATUSES.has(status as EvidenceStatus) ? (status as EvidenceStatus) : 'active';
}

export function extractSupersededBy(fm: Record<string, unknown> | null): string | undefined {
  const refs = normalizeFrontmatterStringList(fm?.superseded_by ?? fm?.supersededBy);
  return refs[0];
}

export function extractSupersedes(fm: Record<string, unknown> | null): string[] {
  return normalizeFrontmatterStringList(fm?.supersedes);
}

function normalizeFrontmatterStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return splitFrontmatterRefs(value)
      .map(normalizeFrontmatterRef)
      .filter((ref): ref is string => ref !== null);
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .flatMap(splitFrontmatterRefs)
    .map(normalizeFrontmatterRef)
    .filter((ref): ref is string => ref !== null);
}

function splitFrontmatterRefs(value: string): string[] {
  const withoutComment = stripYamlInlineComment(value).trim();
  const listMatch = withoutComment.match(/^\[(.*)]$/);
  let refs = withoutComment;
  if (listMatch?.[1] !== undefined) refs = listMatch[1];
  if (!refs.trim()) return [];
  return refs.split(',');
}

function normalizeFrontmatterRef(value: string): string | null {
  const ref = normalizeFrontmatterScalar(value);
  if (!ref) return null;
  const lower = ref.toLowerCase();
  if (EMPTY_FRONTMATTER_REFS.has(lower)) return null;
  return ref;
}

function normalizeFrontmatterScalar(value: string): string {
  return stripMatchingYamlScalarQuotes(stripYamlInlineComment(value).trim()).trim();
}

function stripMatchingYamlScalarQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first !== last) return value;
  if (first === '"') return value.slice(1, -1);
  if (first === "'") return value.slice(1, -1);
  return value;
}

function stripYamlInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const previous = value.charAt(i - 1);
    if (isYamlQuote(char, previous)) {
      if (quote === char) {
        quote = null;
        continue;
      }
      if (quote === null) quote = char;
      continue;
    }
    if (isYamlInlineCommentStart(char, previous, quote, i)) {
      return value.slice(0, i);
    }
  }
  return value;
}

function isYamlQuote(char: string | undefined, previous: string): char is '"' | "'" {
  if (previous === '\\') return false;
  if (char === '"') return true;
  return char === "'";
}

function isYamlInlineCommentStart(char: string | undefined, previous: string, quote: '"' | "'" | null, index: number) {
  if (char !== '#') return false;
  if (quote !== null) return false;
  if (index === 0) return true;
  return /\s/.test(previous);
}

export function inferKind(fm: Record<string, unknown>, filePath: string): EvidenceKind {
  const docKind = fm.doc_kind;
  if (docKind === 'harness-feedback') return 'lesson';
  if (docKind === 'architecture' || docKind === 'architecture-snapshot') return 'architecture';
  if (filePath.includes('/architecture/')) return 'architecture';
  if (docKind === 'decision' || filePath.includes('/decisions/')) return 'decision';
  if (
    docKind === 'plan' ||
    filePath.includes('/plans/') ||
    filePath.includes('/phases/') ||
    filePath.includes('/guides/')
  )
    return 'plan';
  if (
    docKind === 'lesson' ||
    filePath.includes('/lessons/') ||
    filePath.includes('/reflections/') ||
    filePath.includes('/postmortems/') ||
    filePath.includes('/stories/')
  )
    return 'lesson';
  if (docKind === 'discussion' || filePath.includes('/discussions/')) return 'discussion';
  if (docKind === 'research' || filePath.includes('/research/')) return 'research';
  if (docKind === 'spec' || filePath.includes('/features/')) return 'feature';
  return 'plan';
}

/** F287 AC-B1: only canonical public vignette files are eligible for Taste materialization. */
export function isPublicTasteVignettePath(sourcePath: string): boolean {
  return /^taste\/vignettes\/[^/]+\.md$/u.test(sourcePath.replaceAll('\\', '/'));
}

export function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

export function extractSummary(content: string): string | null {
  const afterTitle = stripYamlFrontmatter(content).replace(/^#.*$/m, '');
  const paragraphs = afterTitle.split(/\n\n+/).filter((p) => {
    const t = p.trim();
    if (!t) return false;
    if (isMarkdownSeparator(t)) return false;
    if (t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('```')) return false;
    return true;
  });
  const first = paragraphs[0];
  if (!first) return null;
  const trimmed = first.trim().replace(/\n/g, ' ');
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

export function extractSectionKeywords(content: string): string[] {
  const keywords: string[] = [];
  let activeFence: ActiveFence = null;

  for (const line of content.split(/\r?\n/)) {
    const fenceState = nextFenceState(line, activeFence);
    activeFence = fenceState.activeFence;

    if (fenceState.consumed || activeFence != null) continue;
    const heading = extractHeadingKeyword(line);
    if (!heading) continue;
    keywords.push(heading);
  }
  return keywords;
}

type ActiveFence = { char: '`' | '~'; length: number } | null;

function nextFenceState(line: string, activeFence: ActiveFence): { activeFence: ActiveFence; consumed: boolean } {
  const fenceMatch = line.match(/^\s{0,3}([`~]{3,})/);
  if (!fenceMatch?.[1]) return { activeFence, consumed: false };

  const marker = fenceMatch[1];
  const suffix = line.slice(fenceMatch[0].length);
  const char = marker[0] as '`' | '~';
  const length = marker.length;
  if (activeFence == null) return { activeFence: { char, length }, consumed: true };
  if (activeFence.char === char && length >= activeFence.length && suffix.trim() === '') {
    return { activeFence: null, consumed: true };
  }
  return { activeFence, consumed: false };
}

function extractHeadingKeyword(line: string): string | null {
  const heading = line.match(/^##+\s+(.+)$/)?.[1]?.trim();
  if (!heading || heading.length > 80) return null;
  return heading;
}

export function mergeKeywords(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...primary, ...secondary]) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}
