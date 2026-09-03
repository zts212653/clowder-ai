import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

const { resolveGitHubValidation } = await import('../dist/routes/callback-github-validation.js');

describe('callback GitHub validation response boundary', () => {
  test('keeps the callback route as a consumer instead of defining the resolver inline', async () => {
    const source = await readFile(new URL('../src/routes/callbacks.ts', import.meta.url), 'utf8');

    assert.match(source, /from '\.\/callback-github-validation\.js'/);
    assert.doesNotMatch(source, /function resolveGitHubValidation\(/);
  });

  test('returns a typed success without logging', async () => {
    const warnings = [];
    const result = await resolveGitHubValidation(
      async () => true,
      'PR',
      { warn: (...args) => warnings.push(args) },
      {
        prNumber: 1406,
      },
    );

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(warnings, []);
  });

  test('maps classified failures and logs only normalized evidence', async () => {
    const { GitHubValidationError } = await import('../dist/infrastructure/github/github-object-validator.js');
    const warnings = [];
    const result = await resolveGitHubValidation(
      async () => {
        throw new GitHubValidationError('permission_denied');
      },
      'Repository',
      { warn: (...args) => warnings.push(args) },
      { repoFullName: 'zts212653/clowder-ai' },
    );

    assert.deepEqual(result, {
      ok: false,
      statusCode: 503,
      body: {
        error: 'GitHub credentials cannot access this repository',
        code: 'github_permission_denied',
      },
    });
    assert.deepEqual(warnings[0][0], {
      repoFullName: 'zts212653/clowder-ai',
      githubValidationFailureKind: 'permission_denied',
    });
    assert.equal(warnings[0][1], 'GitHub repository validation failed');
  });
});
