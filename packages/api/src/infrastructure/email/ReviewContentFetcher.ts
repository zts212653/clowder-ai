/**
 * Review Content Fetcher
 * Fetches GitHub PR review content via `gh` CLI and extracts severity findings.
 * Used by ReviewRouter to enrich notifications with P1/P2/P3 signals.
 *
 * Design: Plan A of LL-033 fix — proactive pull, not reactive.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
}

/** Dependency-injection port for testing (replaces real gh CLI calls). */
export interface IReviewContentFetcher {
  fetch(repository: string, prNumber: number): Promise<ReviewContent>;
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

// ─── gh CLI implementation ───────────────────────────────────────────

/** Timeout for gh CLI calls — prevents notification blockage (砚砚 P2-1). */
const GH_TIMEOUT_MS = 15_000;

interface FetcherLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export class GhCliReviewContentFetcher implements IReviewContentFetcher {
  private readonly log: FetcherLogger;

  constructor(log?: FetcherLogger) {
    this.log = log ?? { info: console.log, warn: console.warn };
  }

  async fetch(repository: string, prNumber: number): Promise<ReviewContent> {
    // Use allSettled so partial failure still yields whatever we got (砚砚 P1-2).
    const [reviewResult, commentsResult] = await Promise.allSettled([
      this.fetchReviewBodies(repository, prNumber),
      this.fetchInlineComments(repository, prNumber),
    ]);

    let fetchFailed = false;
    const reviewBodies = reviewResult.status === 'fulfilled' ? reviewResult.value : [];
    const inlineComments = commentsResult.status === 'fulfilled' ? commentsResult.value : [];

    if (reviewResult.status === 'rejected') {
      fetchFailed = true;
      this.log.warn(
        `[ReviewContentFetcher] reviews failed for ${repository}#${prNumber}: ${String(reviewResult.reason)}`,
      );
    }
    if (commentsResult.status === 'rejected') {
      fetchFailed = true;
      this.log.warn(
        `[ReviewContentFetcher] inline comments failed for ${repository}#${prNumber}: ${String(commentsResult.reason)}`,
      );
    }

    const fragments: TextFragment[] = [
      ...reviewBodies.map((body) => ({ text: body, source: 'review_body' as const })),
      ...inlineComments.map((c) => ({ text: c.body, source: 'inline_comment' as const, path: c.path })),
    ];

    const findings = extractSeverityFindings(fragments);

    return {
      findings,
      maxSeverity: getMaxSeverity(findings),
      fetchFailed,
    };
  }

  /**
   * Fetch review bodies with --paginate (砚砚 P1-1) and --timeout (砚砚 P2-1).
   * Errors propagate to caller — fetch() uses allSettled for partial-failure handling.
   */
  private async fetchReviewBodies(repo: string, prNumber: number): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${repo}/pulls/${prNumber}/reviews`,
        '--jq',
        '.[] | .body | select(. != null and . != "") | @json',
      ],
      { timeout: GH_TIMEOUT_MS },
    );
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string);
  }

  /**
   * Fetch inline comments with --paginate (砚砚 P1-1) and --timeout (砚砚 P2-1).
   */
  private async fetchInlineComments(repo: string, prNumber: number): Promise<Array<{ body: string; path: string }>> {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', '--paginate', `repos/${repo}/pulls/${prNumber}/comments`, '--jq', '.[] | {body, path} | @json'],
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
