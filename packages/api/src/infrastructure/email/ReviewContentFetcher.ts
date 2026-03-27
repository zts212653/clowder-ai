/**
 * Review Content Fetcher
 * Fetches GitHub PR review content via `gh` CLI and extracts severity findings.
 * Used by ReviewRouter to enrich notifications with P1/P2/P3 signals.
 *
 * Design: Plan A of LL-033 fix — proactive pull, not reactive.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createModuleLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createModuleLogger('review-content-fetcher');

// ─── Types ───────────────────────────────────────────────────────────

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface SeverityFinding {
  readonly severity: Severity;
  readonly excerpt: string;
  readonly source: 'review_body' | 'inline_comment';
  readonly path?: string;
}

export interface ReviewContent {
  readonly findings: SeverityFinding[];
  readonly maxSeverity: Severity | null;
  /** True if one or both API calls failed — "no findings" may be unreliable. */
  readonly fetchFailed: boolean;
  /** ISO timestamp of the latest review — marks incremental window start. */
  readonly since?: string;
}

/** Dependency-injection port for testing (replaces real gh CLI calls). */
export interface IReviewContentFetcher {
  fetch(repository: string, prNumber: number): Promise<ReviewContent>;
}

// ─── Text normalization ──────────────────────────────────────────────

/**
 * Strip Codex cloud review badge markdown so severity excerpts are readable.
 * Transforms: `**<sub><sub>![P2 Badge](url)</sub></sub>  Title**` → `P2: Title`
 */
export function normalizeReviewText(text: string): string {
  return (
    text
      // Replace full badge line including trailing **: **<sub>..![PN Badge](url)..</sub>  Title**
      .replace(/\*\*<sub><sub>!\[P([0-3]) Badge\]\([^)]*\)<\/sub><\/sub>\s*(.*?)\*\*/gi, 'P$1: $2')
      // Strip any remaining <sub>/<\/sub> tags
      .replace(/<\/?sub>/gi, '')
  );
}

// ─── Pure severity extraction ────────────────────────────────────────

/**
 * Match standalone severity markers: P0, P1, P2, P3.
 * Requires word boundary to avoid false positives like "P100" or "MP3".
 */
const SEVERITY_REGEX = /\bP([0-3])\b/gi;

const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface TextFragment {
  readonly text: string;
  readonly source: 'review_body' | 'inline_comment';
  readonly path?: string;
}

/**
 * Scan text fragments for P0–P3 severity markers.
 * Returns deduplicated findings with context excerpts.
 */
export function extractSeverityFindings(fragments: TextFragment[]): SeverityFinding[] {
  const findings: SeverityFinding[] = [];

  for (const { text, source, path } of fragments) {
    if (!text) continue;

    // Deduplicate per (severity, source, path) within a single fragment
    const seen = new Set<string>();

    for (const match of text.matchAll(SEVERITY_REGEX)) {
      const severity = `P${match[1]}` as Severity;
      const key = `${severity}:${source}:${path ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract ±100 char context around the match
      const idx = match.index!;
      const start = Math.max(0, idx - 100);
      const end = Math.min(text.length, idx + match[0].length + 100);
      const excerpt = text.slice(start, end).trim();

      findings.push({ severity, excerpt, source, ...(path ? { path } : {}) });
    }
  }

  return findings;
}

/** Return the highest severity among findings, or null if none. */
export function getMaxSeverity(findings: SeverityFinding[]): Severity | null {
  if (findings.length === 0) return null;
  return findings.reduce((max, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[max.severity] ? f : max)).severity;
}

// ─── Incremental review selection ────────────────────────────────────

export interface RawReview {
  readonly body: string | null;
  readonly submitted_at: string;
}

export interface SelectedReview {
  readonly body: string;
  readonly submittedAt: string;
}

/**
 * Select the latest review for incremental windowing.
 * Returns the absolute latest review's submittedAt (for since-filtering comments)
 * and only that same review's body for severity scanning.
 *
 * Important: if the latest review body is empty (common for approvals),
 * we must NOT fall back to an older non-empty body. Doing so replays stale
 * P1/P2 findings that may already have been addressed.
 */
export function selectLatestReview(reviews: RawReview[]): SelectedReview | null {
  if (reviews.length === 0) return null;
  const sorted = [...reviews].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  return {
    body: sorted[0]!.body ?? '',
    submittedAt: sorted[0]!.submitted_at,
  };
}

// ─── gh CLI implementation ───────────────────────────────────────────

/** Timeout for gh CLI calls — prevents notification blockage (砚砚 P2-1). */
const GH_TIMEOUT_MS = 15_000;

interface FetcherLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export class GhCliReviewContentFetcher implements IReviewContentFetcher {
  private readonly log: FetcherLogger;

  constructor(customLog?: FetcherLogger) {
    this.log = customLog ?? {
      info: (msg: string) => log.info(msg),
      warn: (msg: string) => log.warn(msg),
    };
  }

  async fetch(repository: string, prNumber: number): Promise<ReviewContent> {
    let fetchFailed = false;

    // Step 1: fetch all reviews to find the latest one (incremental window)
    let latestReview: SelectedReview | null = null;
    try {
      const rawReviews = await this.fetchRawReviews(repository, prNumber);
      latestReview = selectLatestReview(rawReviews);
    } catch (err) {
      fetchFailed = true;
      this.log.warn(`[ReviewContentFetcher] reviews failed for ${repository}#${prNumber}: ${String(err)}`);
    }

    // Step 2: fetch inline comments since the latest review (incremental)
    let inlineComments: Array<{ body: string; path: string }> = [];
    try {
      inlineComments = await this.fetchInlineComments(repository, prNumber, latestReview?.submittedAt);
    } catch (err) {
      fetchFailed = true;
      this.log.warn(`[ReviewContentFetcher] inline comments failed for ${repository}#${prNumber}: ${String(err)}`);
    }

    // Step 3: normalize text (strip Codex badge markup) then extract severity
    const fragments: TextFragment[] = [];
    if (latestReview?.body) {
      fragments.push({ text: normalizeReviewText(latestReview.body), source: 'review_body' });
    }
    fragments.push(
      ...inlineComments.map((c) => ({
        text: normalizeReviewText(c.body),
        source: 'inline_comment' as const,
        path: c.path,
      })),
    );

    const findings = extractSeverityFindings(fragments);

    return {
      findings,
      maxSeverity: getMaxSeverity(findings),
      fetchFailed,
      since: latestReview?.submittedAt,
    };
  }

  /** Fetch all reviews with submitted_at for incremental selection. */
  private async fetchRawReviews(repo: string, prNumber: number): Promise<RawReview[]> {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', '--paginate', `repos/${repo}/pulls/${prNumber}/reviews`, '--jq', '.[] | {body, submitted_at} | @json'],
      { timeout: GH_TIMEOUT_MS },
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RawReview);
  }

  /** Fetch inline comments, optionally filtered by `since` timestamp. */
  private async fetchInlineComments(
    repo: string,
    prNumber: number,
    since?: string,
  ): Promise<Array<{ body: string; path: string }>> {
    const endpoint = since
      ? `repos/${repo}/pulls/${prNumber}/comments?since=${since}`
      : `repos/${repo}/pulls/${prNumber}/comments`;
    const { stdout } = await execFileAsync(
      'gh',
      ['api', '--paginate', endpoint, '--jq', '.[] | {body, path} | @json'],
      { timeout: GH_TIMEOUT_MS },
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { body: string; path: string });
  }
}
