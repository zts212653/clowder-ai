/**
 * community-link-parser tests (F168 Phase B — Task 3)
 *
 * Pure function — table-driven tests for PR body closing-keyword parsing.
 * Tests: GitHub official syntax variants, case insensitivity, multi-issue,
 * no-issue, cross-repo ignore, malformed input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Task 3: module not created yet — tests will fail until implementation exists
const { parseLinkedIssues } = await import('../dist/domains/community/community-link-parser.js');

describe('parseLinkedIssues — closing keywords', () => {
  it('parses "Fixes #42"', () => {
    assert.deepStrictEqual(parseLinkedIssues('Fixes #42'), [42]);
  });

  it('parses "fixes #42" (lowercase)', () => {
    assert.deepStrictEqual(parseLinkedIssues('fixes #42'), [42]);
  });

  it('parses "fix #42"', () => {
    assert.deepStrictEqual(parseLinkedIssues('Fix #42'), [42]);
  });

  it('parses "fixed #42"', () => {
    assert.deepStrictEqual(parseLinkedIssues('Fixed #42'), [42]);
  });

  it('parses "Closes #10"', () => {
    assert.deepStrictEqual(parseLinkedIssues('Closes #10'), [10]);
  });

  it('parses "close #10"', () => {
    assert.deepStrictEqual(parseLinkedIssues('close #10'), [10]);
  });

  it('parses "closed #10"', () => {
    assert.deepStrictEqual(parseLinkedIssues('closed #10'), [10]);
  });

  it('parses "Resolves #99"', () => {
    assert.deepStrictEqual(parseLinkedIssues('Resolves #99'), [99]);
  });

  it('parses "resolve #99"', () => {
    assert.deepStrictEqual(parseLinkedIssues('resolve #99'), [99]);
  });

  it('parses "resolved #99"', () => {
    assert.deepStrictEqual(parseLinkedIssues('resolved #99'), [99]);
  });

  it('parses keyword with colon: "Fixes: #5"', () => {
    assert.deepStrictEqual(parseLinkedIssues('Fixes: #5'), [5]);
  });

  it('parses multiple issues from one body', () => {
    const body = 'This PR fixes #1 and closes #2.\n\nAlso resolves #3.';
    const result = parseLinkedIssues(body);
    assert.deepStrictEqual(
      result.sort((a, b) => a - b),
      [1, 2, 3],
    );
  });

  it('deduplicates the same issue mentioned twice', () => {
    assert.deepStrictEqual(parseLinkedIssues('fixes #5\nfixes #5'), [5]);
  });

  it('returns [] for body with no closing keywords', () => {
    assert.deepStrictEqual(parseLinkedIssues('General improvements and refactoring'), []);
  });

  it('returns [] for null body', () => {
    assert.deepStrictEqual(parseLinkedIssues(null), []);
  });

  it('returns [] for undefined body', () => {
    assert.deepStrictEqual(parseLinkedIssues(undefined), []);
  });

  it('returns [] for empty string', () => {
    assert.deepStrictEqual(parseLinkedIssues(''), []);
  });

  it('ignores cross-repo references: "fixes owner/repo#5" (same-repo only)', () => {
    // Cross-repo syntax not supported in Phase B — only bare #N references
    const result = parseLinkedIssues('fixes owner/repo#5');
    assert.deepStrictEqual(result, [], 'cross-repo reference should be ignored');
  });

  it('ignores plain #N references without a closing keyword', () => {
    // "see #42" or "#42" without fix/close/resolve should not be treated as closing
    assert.deepStrictEqual(parseLinkedIssues('related to #42, see #43'), []);
  });
});
