import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { GitHubValidationError, classifyGhValidationFailure, validateGitHubApiResource } = await import(
  '../dist/infrastructure/github/github-object-validator.js'
);

function commandError({ code = 1, stdout = '', stderr = '', killed = false, signal = null } = {}) {
  return Object.assign(new Error('gh failed'), { code, stdout, stderr, killed, signal });
}

describe('GitHub API subject validation', () => {
  it('uses the gh auth store when no explicit plugin token is configured', async () => {
    const calls = [];
    const baseEnv = {
      HOME: '/tmp/gh-auth-home',
      GH_TOKEN: 'ambient-gh-token',
      GITHUB_TOKEN: 'ambient-github-token',
    };

    const result = await validateGitHubApiResource('repos/o/r/pulls/1', '.number', {
      baseEnv,
      execFileAsync: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: '1\n' };
      },
    });

    assert.equal(result, true);
    assert.equal(calls[0].options.env.HOME, '/tmp/gh-auth-home');
    assert.equal(calls[0].options.env.GH_TOKEN, undefined);
    assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined);
  });

  it('passes only an explicit plugin token to the gh child process', async () => {
    const calls = [];
    await validateGitHubApiResource('repos/o/r/pulls/1', '.number', {
      token: ' explicit-plugin-token ',
      baseEnv: { GH_TOKEN: 'ambient-gh-token', GITHUB_TOKEN: 'ambient-github-token' },
      execFileAsync: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: '1\n' };
      },
    });

    assert.equal(calls[0].options.env.GITHUB_TOKEN, 'explicit-plugin-token');
    assert.equal(calls[0].options.env.GH_TOKEN, undefined);
  });

  it('classifies missing gh credentials honestly', () => {
    assert.equal(classifyGhValidationFailure(commandError({ code: 4 })), 'authentication_required');
    assert.equal(
      classifyGhValidationFailure(commandError({ stderr: 'gh: Requires authentication (HTTP 401)' })),
      'authentication_required',
    );
  });

  it('distinguishes permission denial, rate limiting, not-found, and transport failure', () => {
    assert.equal(
      classifyGhValidationFailure(commandError({ stderr: 'gh: Resource not accessible (HTTP 403)' })),
      'permission_denied',
    );
    assert.equal(
      classifyGhValidationFailure(
        commandError({ stderr: 'gh: API rate limit exceeded for user ID 26771442 (HTTP 403)' }),
      ),
      'rate_limited',
    );
    assert.equal(classifyGhValidationFailure(commandError({ stderr: 'gh: Not Found (HTTP 404)' })), 'not_found');
    assert.equal(classifyGhValidationFailure(commandError({ code: 'ENETUNREACH' })), 'unavailable');
  });

  it('reproduces repo-pass then PR-rate-limit without turning the PR into not-found', async () => {
    const execFileAsync = async (_file, args) => {
      if (args[1] === 'repos/zts212653/clowder-ai') return { stdout: 'zts212653/clowder-ai\n' };
      throw commandError({ stderr: 'gh: API rate limit exceeded for user ID 26771442 (HTTP 403)' });
    };

    assert.equal(await validateGitHubApiResource('repos/zts212653/clowder-ai', '.full_name', { execFileAsync }), true);
    await assert.rejects(
      validateGitHubApiResource('repos/zts212653/clowder-ai/pulls/1406', '.number', { execFileAsync }),
      (error) => error instanceof GitHubValidationError && error.kind === 'rate_limited',
    );
  });
});
