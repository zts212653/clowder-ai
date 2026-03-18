// @ts-check

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { extractSeverityFindings, getMaxSeverity } from '../dist/infrastructure/email/ReviewContentFetcher.js';
import { buildReviewMessageContent } from '../dist/infrastructure/email/ReviewRouter.js';

// ─── extractSeverityFindings ──────────────────────────────────────────

describe('extractSeverityFindings', () => {
  it('extracts P1 from review body', () => {
    const findings = extractSeverityFindings([
      { text: 'Found a P1 issue: race condition in flush logic', source: 'review_body' },
    ]);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'P1');
    assert.strictEqual(findings[0].source, 'review_body');
    assert.ok(findings[0].excerpt.includes('P1'));
  });

  it('extracts P0 and P2 from inline comment with path', () => {
    const findings = extractSeverityFindings([
      { text: 'P0 critical: data loss. Also P2 style nit.', source: 'inline_comment', path: 'src/foo.ts' },
    ]);
    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].severity, 'P0');
    assert.strictEqual(findings[0].path, 'src/foo.ts');
    assert.strictEqual(findings[1].severity, 'P2');
  });

  it('deduplicates same severity within same fragment', () => {
    const findings = extractSeverityFindings([
      { text: 'P1 here and P1 again and P1 one more time', source: 'review_body' },
    ]);
    // Same (severity, source, path) tuple → deduplicated to 1
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'P1');
  });

  it('does NOT deduplicate across different fragments', () => {
    const findings = extractSeverityFindings([
      { text: 'P1 in body', source: 'review_body' },
      { text: 'P1 in comment', source: 'inline_comment', path: 'a.ts' },
    ]);
    assert.strictEqual(findings.length, 2);
  });

  it('ignores P followed by numbers > 3 (e.g., P100)', () => {
    const findings = extractSeverityFindings([{ text: 'See P100 and P4 notes', source: 'review_body' }]);
    assert.strictEqual(findings.length, 0);
  });

  it('returns empty for text without severity markers', () => {
    const findings = extractSeverityFindings([{ text: 'Looks good, no issues found.', source: 'review_body' }]);
    assert.strictEqual(findings.length, 0);
  });

  it('handles empty text gracefully', () => {
    const findings = extractSeverityFindings([{ text: '', source: 'review_body' }]);
    assert.strictEqual(findings.length, 0);
  });

  it('extracts P3 as informational', () => {
    const findings = extractSeverityFindings([
      { text: 'P3 minor: consider renaming variable', source: 'inline_comment', path: 'lib/x.ts' },
    ]);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'P3');
  });

  it('matches lowercase p1/p2 (case-insensitive, 砚砚 P2)', () => {
    const findings = extractSeverityFindings([{ text: 'found a p1 issue and a p2 nit', source: 'review_body' }]);
    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].severity, 'P1', 'should normalize to uppercase');
    assert.strictEqual(findings[1].severity, 'P2');
  });

  it('does not match MP3 or P1234', () => {
    const findings = extractSeverityFindings([
      { text: 'Play this MP3 file. Also ticket P1234 is unrelated.', source: 'review_body' },
    ]);
    assert.strictEqual(findings.length, 0);
  });
});

// ─── getMaxSeverity ──────────────────────────────────────────────────

describe('getMaxSeverity', () => {
  it('returns null for empty findings', () => {
    assert.strictEqual(getMaxSeverity([]), null);
  });

  it('returns P0 when P0 and P2 both present', () => {
    assert.strictEqual(
      getMaxSeverity([
        { severity: 'P2', excerpt: 'x', source: 'review_body' },
        { severity: 'P0', excerpt: 'y', source: 'inline_comment' },
      ]),
      'P0',
    );
  });

  it('returns P1 for single P1', () => {
    assert.strictEqual(getMaxSeverity([{ severity: 'P1', excerpt: 'x', source: 'review_body' }]), 'P1');
  });

  it('returns P3 when only P3 present', () => {
    assert.strictEqual(getMaxSeverity([{ severity: 'P3', excerpt: 'x', source: 'inline_comment' }]), 'P3');
  });
});

// ─── buildReviewMessageContent ───────────────────────────────────────

describe('buildReviewMessageContent', () => {
  const baseEvent = {
    prNumber: 555,
    title: 'fix(sync): enforce static gates',
    repository: 'org/repo',
    reviewType: /** @type {'commented'} */ ('commented'),
    reviewer: 'codex-bot',
  };

  it('builds basic message without fetcher (reviewContent=null)', () => {
    const msg = buildReviewMessageContent(baseEvent, 'Commented', null);
    assert.ok(msg.includes('GitHub Review 通知'));
    assert.ok(msg.includes('PR #555'));
    assert.ok(msg.includes('Commented'));
    assert.ok(msg.includes('@codex-bot'));
    assert.ok(!msg.includes('检测到'));
  });

  it('includes severity header when P1 found', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [{ severity: 'P1', excerpt: 'validate calls wrong mode', source: 'inline_comment', path: 'sync.sh' }],
      maxSeverity: 'P1',
      fetchFailed: false,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Commented', content);
    assert.ok(msg.includes('Review 检测到 P1'));
    assert.ok(msg.includes('Findings (1)'));
    assert.ok(msg.includes('**P1** (sync.sh)'));
  });

  it('includes severity header when P0 found', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [{ severity: 'P0', excerpt: 'data loss risk', source: 'review_body' }],
      maxSeverity: 'P0',
      fetchFailed: false,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Reviewed', content);
    assert.ok(msg.includes('Review 检测到 P0'));
  });

  it('does NOT show severity header for P3-only findings', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [{ severity: 'P3', excerpt: 'minor nit', source: 'review_body' }],
      maxSeverity: 'P3',
      fetchFailed: false,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Commented', content);
    assert.ok(!msg.includes('检测到'));
    assert.ok(!msg.includes('Findings'));
  });

  it('shows multiple actionable findings', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [
        { severity: 'P1', excerpt: 'race condition', source: 'inline_comment', path: 'a.ts' },
        { severity: 'P2', excerpt: 'missing validation', source: 'inline_comment', path: 'b.ts' },
        { severity: 'P3', excerpt: 'rename', source: 'review_body' },
      ],
      maxSeverity: 'P1',
      fetchFailed: false,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Reviewed', content);
    assert.ok(msg.includes('Findings (2)'), 'should count only P1+P2, not P3');
    assert.ok(msg.includes('**P1** (a.ts)'));
    assert.ok(msg.includes('**P2** (b.ts)'));
    assert.ok(!msg.includes('rename'), 'P3 finding should not appear in findings section');
  });

  it('omits reviewer line when reviewer is undefined', () => {
    const msg = buildReviewMessageContent({ ...baseEvent, reviewer: undefined }, 'Approved', null);
    assert.ok(!msg.includes('Reviewer:'));
  });

  // ── P1-2 fix: fetch failure warning ──────────────────────────────

  it('shows warning when fetchFailed=true and no findings', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [],
      maxSeverity: null,
      fetchFailed: true,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Commented', content);
    assert.ok(msg.includes('未能完整拉取'), 'should warn about fetch failure');
    assert.ok(!msg.includes('检测到'), 'should not claim severity detected');
  });

  it('shows both findings and warning when partial fetch failure', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [{ severity: 'P1', excerpt: 'issue found', source: 'review_body' }],
      maxSeverity: 'P1',
      fetchFailed: true,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Reviewed', content);
    assert.ok(msg.includes('Review 检测到 P1'), 'should show found severity');
    assert.ok(msg.includes('未能完整拉取'), 'should also warn about partial failure');
  });

  it('does NOT show warning when fetchFailed=false', () => {
    /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').ReviewContent} */
    const content = {
      findings: [],
      maxSeverity: null,
      fetchFailed: false,
    };
    const msg = buildReviewMessageContent(baseEvent, 'Commented', content);
    assert.ok(!msg.includes('未能完整拉取'), 'no warning when fetch succeeded');
  });
});
