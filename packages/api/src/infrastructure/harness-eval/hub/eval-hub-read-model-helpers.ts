import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ParsedVerdictMarkdown {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  markdown: string;
}

export interface EvalHubEvidenceRefs {
  snapshotRefs: string[];
  attributionRefs: string[];
  metricRefs: string[];
  otherRefs: string[];
}

export interface EvalHubHarnessUnderEval {
  featureId: string;
  componentId: string;
  name: string;
}

export type EvalHubVerdict = 'delete_sunset' | 'build' | 'fix' | 'keep_observe';

export function parseVerdictMarkdown(path: string): ParsedVerdictMarkdown {
  const markdown = readFileSync(path, 'utf8');
  const frontmatter = parseFrontmatter(markdown);
  return {
    id: basename(path, '.md'),
    path,
    frontmatter,
    markdown,
  };
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function extractBullet(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^- ${escaped}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

export function extractEvidenceRefs(markdown: string): EvalHubEvidenceRefs {
  const lines = markdown.split('\n').map((line) => line.trim());
  const evidenceStart = lines.findIndex((line) => line === 'Evidence:');
  const refs = evidenceStart === -1 ? [] : extractEvidenceSectionRefs(lines.slice(evidenceStart + 1));
  return {
    snapshotRefs: refs.filter((ref) => ref.startsWith('snapshot:')),
    attributionRefs: refs.filter((ref) => ref.startsWith('attribution:')),
    metricRefs: refs.filter((ref) => ref.startsWith('metric:')),
    otherRefs: refs.filter(
      (ref) => !ref.startsWith('snapshot:') && !ref.startsWith('attribution:') && !ref.startsWith('metric:'),
    ),
  };
}

function extractEvidenceSectionRefs(lines: string[]): string[] {
  const refs: string[] = [];
  for (const line of lines) {
    if (isMarkdownSectionHeading(line)) break;
    if (line.startsWith('- ')) refs.push(line.slice(2).trim());
  }
  return refs;
}

function isMarkdownSectionHeading(line: string): boolean {
  if (line.length === 0 || line.startsWith('- ')) return false;
  return line.endsWith(':') || /^#{1,6}\s+/.test(line);
}

export function parseHarness(value: string | undefined): EvalHubHarnessUnderEval {
  const text = requiredText(value, 'harness');
  const match = text.match(/^([^/]+)\/([^\s]+)\s+\((.+)\)$/);
  if (!match) throw new Error(`invalid harness format: ${text}`);
  return {
    featureId: match[1],
    componentId: match[2],
    name: match[3],
  };
}

export function requiredVerdict(value: string | undefined): EvalHubVerdict {
  const normalized = requiredText(value, 'verdict').replaceAll('`', '');
  if (
    normalized === 'delete_sunset' ||
    normalized === 'build' ||
    normalized === 'fix' ||
    normalized === 'keep_observe'
  ) {
    return normalized;
  }
  throw new Error(`unknown verdict: ${normalized}`);
}

export function requiredText(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

export function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

/**
 * F192 P2 — Eval Hub lifecycle staleness (per-verdict deadline check).
 *
 * Reports whether a verdict has crossed its own declared `nextEvalAt`. The
 * "without a newer live verdict superseding it" half of the stale contract is
 * applied in a second pass by {@link markSupersededAsClosed} — keeping the
 * two concerns separated (per-item deadline vs. per-domain supersede) makes
 * each pure and individually testable.
 *
 * We deliberately do NOT add a separate SLA grace window here: `nextEvalAt`
 * is computed from `domain.sla.reevalWithinHours` at verdict-creation time,
 * so any additional buffer at read time would double-discount the same SLA
 * budget and silently delay the very signal Eval Hub exists to surface.
 *
 * If a verdict happens to omit `nextEvalAt`, we cannot reason about staleness
 * and return `false` (the absence itself is a data-quality concern that should
 * be caught upstream by the verdict packet schema, not impersonated here).
 */
export function computeStale(nextEvalAt: string | undefined, now: Date): boolean {
  if (!nextEvalAt) return false;
  const deadlineMs = Date.parse(nextEvalAt);
  if (Number.isNaN(deadlineMs)) return false;
  return now.getTime() > deadlineMs;
}

/**
 * OQ-20 P1-2 fix: Compute next cron fire time from domain frequency.
 *
 * Daily domains fire at 03:00 UTC every day (`0 3 * * *`).
 * Weekly domains fire at 03:00 UTC every Sunday (`0 3 * * 0`).
 *
 * Returns the next fire time after `now`. This is what the user sees as
 * "下次评估" — the actual scheduler trigger time, not a verdict re-eval
 * deadline. Available for ALL domains including those without verdicts.
 */
export function computeNextCronFire(frequency: string, now: Date): Date {
  const FIRE_HOUR_UTC = 3;
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);

  if (frequency === 'weekly') {
    next.setUTCHours(FIRE_HOUR_UTC);
    const daysUntilSunday = (7 - next.getUTCDay()) % 7;
    if (daysUntilSunday === 0 && now.getTime() >= next.getTime()) {
      next.setUTCDate(next.getUTCDate() + 7);
    } else {
      next.setUTCDate(next.getUTCDate() + daysUntilSunday);
    }
  } else {
    next.setUTCHours(FIRE_HOUR_UTC);
    if (now.getTime() >= next.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next;
}

/**
 * F192 P2 — Eval Hub supersede gating (PR 791 review fix).
 *
 * Closes the "stale" lifecycle contract: an overdue verdict is only stale if a
 * newer live verdict has not already superseded it for the same domain. After
 * a newer verdict lands, the older verdict transitions from "stale" to "closed
 * by re-eval" (per F192 AC-E7), so its overdue deadline must stop ticking
 * counts.stale.
 *
 * Assumes `items` are already sorted by `trend.generatedAt` desc — the first
 * item seen per domain is the latest active verdict; every subsequent item in
 * the same domain has been superseded and has its `lifecycle.stale` forced to
 * `false`. Mutates `items` in place, consistent with the sibling sort/map style
 * upstream in `loadEvalHubSummary`.
 */
export function markSupersededAsClosed(items: Array<{ domainId: string; lifecycle: { stale: boolean } }>): void {
  const seenDomains = new Set<string>();
  for (const item of items) {
    if (seenDomains.has(item.domainId)) {
      item.lifecycle.stale = false;
    } else {
      seenDomains.add(item.domainId);
    }
  }
}
