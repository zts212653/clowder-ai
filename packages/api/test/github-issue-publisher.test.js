import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F235 Task 5: GitHubIssuePublisher — raw fetch to GitHub REST API.
 * Tests mock globalThis.fetch to avoid real API calls.
 */

let GitHubIssuePublisher;
let originalFetch;

const validConfig = {
  token: 'ghp_testtoken1234567890abcdef',
  repoAllowlist: ['clowder-ai/cat-cafe'],
};

const validInput = {
  repo: 'clowder-ai/cat-cafe',
  title: 'Permission prompts too frequent',
  body: '## Problem\nUser cancelled 4 times.',
  labels: ['bug', 'user-reported'],
};

function mockFetch(status, body) {
  return async (url, opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe('F235: GitHubIssuePublisher', () => {
  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const mod = await import('../dist/domains/community/GitHubIssuePublisher.js');
    GitHubIssuePublisher = mod.GitHubIssuePublisher;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates issue and returns number + URL', async () => {
    globalThis.fetch = mockFetch(201, {
      number: 347,
      html_url: 'https://github.com/clowder-ai/cat-cafe/issues/347',
    });

    const publisher = new GitHubIssuePublisher(validConfig);
    const result = await publisher.publish(validInput);

    assert.equal(result.issueNumber, 347);
    assert.equal(result.issueUrl, 'https://github.com/clowder-ai/cat-cafe/issues/347');
  });

  it('sends correct request to GitHub API', async () => {
    let capturedUrl;
    let capturedOpts;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return {
        ok: true,
        status: 201,
        json: async () => ({ number: 1, html_url: 'https://github.com/x/y/issues/1' }),
      };
    };

    const publisher = new GitHubIssuePublisher(validConfig);
    await publisher.publish(validInput);

    assert.equal(capturedUrl, 'https://api.github.com/repos/clowder-ai/cat-cafe/issues');
    assert.equal(capturedOpts.method, 'POST');
    assert.ok(capturedOpts.headers.Authorization.includes('Bearer'));
    assert.equal(capturedOpts.headers.Accept, 'application/vnd.github+json');

    const body = JSON.parse(capturedOpts.body);
    assert.equal(body.title, 'Permission prompts too frequent');
    assert.deepEqual(body.labels, ['bug', 'user-reported']);
  });

  it('throws on 401 Unauthorized', async () => {
    globalThis.fetch = mockFetch(401, { message: 'Bad credentials' });

    const publisher = new GitHubIssuePublisher(validConfig);
    await assert.rejects(
      () => publisher.publish(validInput),
      (err) => err.message.includes('401') || err.message.includes('auth'),
    );
  });

  it('throws on 403 Forbidden', async () => {
    globalThis.fetch = mockFetch(403, { message: 'Resource not accessible by integration' });

    const publisher = new GitHubIssuePublisher(validConfig);
    await assert.rejects(
      () => publisher.publish(validInput),
      (err) => err.message.includes('403') || err.message.includes('permission'),
    );
  });

  it('throws on 422 Validation Error', async () => {
    globalThis.fetch = mockFetch(422, { message: 'Validation Failed' });

    const publisher = new GitHubIssuePublisher(validConfig);
    await assert.rejects(
      () => publisher.publish(validInput),
      (err) => err.message.includes('422') || err.message.includes('validation'),
    );
  });

  it('throws on 500 Server Error', async () => {
    globalThis.fetch = mockFetch(500, { message: 'Internal Server Error' });

    const publisher = new GitHubIssuePublisher(validConfig);
    await assert.rejects(
      () => publisher.publish(validInput),
      (err) => err.message.includes('500') || err.message.includes('server'),
    );
  });

  it('throws on network error', async () => {
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };

    const publisher = new GitHubIssuePublisher(validConfig);
    await assert.rejects(
      () => publisher.publish(validInput),
      (err) => err.message.includes('ENOTFOUND') || err.message.includes('network'),
    );
  });

  it('throws when token is missing', () => {
    assert.throws(
      () => new GitHubIssuePublisher({ ...validConfig, token: '' }),
      (err) => err.message.includes('token') || err.message.includes('GITHUB_TOKEN'),
    );
  });

  it('rejects repo not in allowlist (defense in depth)', async () => {
    globalThis.fetch = mockFetch(201, { number: 1, html_url: 'https://github.com/x/y/issues/1' });

    const publisher = new GitHubIssuePublisher(validConfig);
    await assert.rejects(
      () => publisher.publish({ ...validInput, repo: 'evil-org/evil-repo' }),
      (err) => err.message.includes('allowlist') || err.message.includes('not allowed'),
    );
  });
});
