import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function ghFailure(message, { code = 1, stdout = '', stderr = '' } = {}) {
  return Object.assign(new Error(message), { code, stdout, stderr });
}

describe('GitHub object validator', () => {
  test('classifies REST 404 as an absent object', async () => {
    const { resolveGitHubObjectLookup } = await import('../dist/infrastructure/github/github-object-validator.js');
    const error = ghFailure('Command failed: gh api repos/owner/repo/pulls/404', {
      stdout: '{"message":"Not Found","status":"404"}',
      stderr: 'gh: Not Found (HTTP 404)',
    });

    const result = await resolveGitHubObjectLookup(async () => {
      throw error;
    });

    assert.deepEqual(result, { found: false });
  });

  test('classifies GraphQL repository resolution failure as an absent object', async () => {
    const { resolveGitHubObjectLookup } = await import('../dist/infrastructure/github/github-object-validator.js');
    const error = ghFailure('Command failed: gh repo view owner/missing', {
      stderr: 'GraphQL: Could not resolve to a Repository with the name owner/missing.',
    });

    const result = await resolveGitHubObjectLookup(async () => {
      throw error;
    });

    assert.deepEqual(result, { found: false });
  });

  test('propagates unattributed HTTP 404 text instead of reporting an absent object', async () => {
    const { resolveGitHubObjectLookup } = await import('../dist/infrastructure/github/github-object-validator.js');
    const error = ghFailure('upstream proxy: HTTP 404');

    await assert.rejects(
      () =>
        resolveGitHubObjectLookup(async () => {
          throw error;
        }),
      (thrown) => thrown === error,
    );
  });

  test('propagates REST rate-limit failures instead of reporting an absent object', async () => {
    const { resolveGitHubObjectLookup } = await import('../dist/infrastructure/github/github-object-validator.js');
    const error = ghFailure('Command failed: gh api repos/owner/repo/pulls/1410', {
      stdout: '{"message":"API rate limit exceeded","status":"403"}',
      stderr: 'gh: API rate limit exceeded (HTTP 403)',
    });

    await assert.rejects(
      () =>
        resolveGitHubObjectLookup(async () => {
          throw error;
        }),
      (thrown) => thrown === error,
    );
  });

  test('propagates authentication and timeout failures', async () => {
    const { resolveGitHubObjectLookup } = await import('../dist/infrastructure/github/github-object-validator.js');
    const authError = ghFailure('gh: Bad credentials (HTTP 401)', { stderr: 'gh: Bad credentials (HTTP 401)' });
    const timeoutError = Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT', killed: true });

    await assert.rejects(
      () =>
        resolveGitHubObjectLookup(async () => {
          throw authError;
        }),
      (thrown) => thrown === authError,
    );
    await assert.rejects(
      () =>
        resolveGitHubObjectLookup(async () => {
          throw timeoutError;
        }),
      (thrown) => thrown === timeoutError,
    );
  });
});
