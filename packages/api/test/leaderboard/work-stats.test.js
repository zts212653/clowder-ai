import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeWorkStats, parseGitLog } from '../../dist/domains/leaderboard/work-stats.js';

const CAT_NAMES = { opus: '布偶猫', codex: '缅因猫', gemini: '暹罗猫', owner: '铲屎官' };

describe('parseGitLog', () => {
  it('parses pipe-delimited git log lines', () => {
    const raw = [
      'abc123|noreply@anthropic.com|2026-03-10T10:00:00Z|feat(F075): add leaderboard|Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
      'def456|codex@openai.com|2026-03-09T10:00:00Z|fix: resolve bug|Co-authored-by: Codex <codex@openai.com>',
    ].join('\n');

    const entries = parseGitLog(raw);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].hash, 'abc123');
    assert.equal(entries[0].author, 'noreply@anthropic.com');
    assert.equal(entries[0].message, 'feat(F075): add leaderboard');
    assert.equal(entries[0].coAuthors, 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>');
  });

  it('handles empty input', () => {
    assert.deepEqual(parseGitLog(''), []);
    assert.deepEqual(parseGitLog('\n'), []);
  });
});

describe('computeWorkStats', () => {
  const entries = [
    {
      hash: '1',
      author: 'noreply@anthropic.com',
      date: '2026-03-10',
      message: 'feat: add feature',
      coAuthors: 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
    },
    {
      hash: '2',
      author: 'noreply@anthropic.com',
      date: '2026-03-09',
      message: 'fix: resolve bug in parser',
      coAuthors: 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
    },
    {
      hash: '3',
      author: 'codex@openai.com',
      date: '2026-03-09',
      message: 'review: F070 code review feedback',
      coAuthors: '',
    },
    { hash: '4', author: 'you@local', date: '2026-03-08', message: 'docs: update readme', coAuthors: '' },
  ];

  const authorMap = {
    'noreply@anthropic.com': 'opus',
    'codex@openai.com': 'codex',
    'you@local': 'owner',
  };

  it('counts total commits per cat', () => {
    const result = computeWorkStats(entries, authorMap, CAT_NAMES);
    assert.equal(result.commits[0].catId, 'opus');
    assert.equal(result.commits[0].count, 2);
    assert.equal(result.commits[0].rank, 1);
  });

  it('identifies bug fixes from commit messages', () => {
    const result = computeWorkStats(entries, authorMap, CAT_NAMES);
    const opusBugs = result.bugFixes.find((c) => c.catId === 'opus');
    assert.ok(opusBugs);
    assert.equal(opusBugs.count, 1); // "fix: resolve bug"
  });

  it('identifies reviews from commit messages', () => {
    const result = computeWorkStats(entries, authorMap, CAT_NAMES);
    const codexReviews = result.reviews.find((c) => c.catId === 'codex');
    assert.ok(codexReviews);
    assert.equal(codexReviews.count, 1); // "review: F070"
  });
});
