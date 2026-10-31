import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateHandoffDigest } from '../dist/domains/cats/services/session/HandoffDigestGenerator.js';

describe('HandoffDigestGenerator', () => {
  // Shared test data
  const handoffSummaries = [
    {
      invocationId: 'inv-1',
      eventCount: 20,
      toolCalls: ['Read', 'Edit'],
      errors: 0,
      durationMs: 5000,
      keyMessages: ['Implemented feature X'],
    },
  ];

  const extractiveDigest = {
    v: 1,
    sessionId: 'sess1',
    threadId: 'thread1',
    catId: 'opus',
    seq: 3,
    time: { createdAt: 1709700000000, sealedAt: 1709700060000 },
    invocations: [{ toolNames: ['Read', 'Edit'] }],
    filesTouched: [{ path: 'src/foo.ts', ops: ['edit'] }],
    errors: [],
  };

  const recentMessages = [
    { role: 'user', content: 'Fix the bug', timestamp: 1709700010000 },
    { role: 'assistant', content: 'Done, applied patch.', timestamp: 1709700020000 },
  ];

  test('versioned gateway keeps one v1 and preserves tenant query/hash', async () => {
    let actual;
    await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'FAKE',
      baseUrl: 'https://gateway.invalid/v1?tenant=fixture#part',
      fetchFn: async (url) => {
        actual = url;
        return { ok: false };
      },
    });
    assert.equal(actual, 'https://gateway.invalid/v1/messages?tenant=fixture#part');
  });

  test('invalid endpoint scheme never calls fetch', async () => {
    let calls = 0;
    const result = await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'FAKE',
      baseUrl: 'file:///tmp/fixture',
      fetchFn: async () => {
        calls++;
        return { ok: false };
      },
    });
    assert.equal(result, null);
    assert.equal(calls, 0);
  });

  test('returns markdown body on successful API response', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '## Session Summary\nFixed a bug in foo.ts.' }],
      }),
    });

    const result = await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    assert.ok(result);
    assert.ok(result.body.includes('Session Summary'));
    assert.equal(result.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.v, 1);
    assert.ok(result.generatedAt > 0);
  });

  test('returns null when API returns error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'bad-key',
      fetchFn: mockFetch,
    });

    assert.equal(result, null);
  });

  test('returns null on timeout (AbortError)', async () => {
    const mockFetch = async (_url, _opts) => {
      // Simulate abort
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    };

    const result = await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'test-key',
      timeoutMs: 100,
      fetchFn: mockFetch,
    });

    assert.equal(result, null);
  });

  test('returns null on network error', async () => {
    const mockFetch = async () => {
      throw new Error('Network error');
    };

    const result = await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    assert.equal(result, null);
  });

  test('passes correct headers and model to API', async () => {
    let capturedUrl;
    let capturedOpts;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'summary' }],
        }),
      };
    };

    await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'sk-test-123',
      baseUrl: 'https://custom.api.com',
      fetchFn: mockFetch,
    });

    assert.equal(capturedUrl, 'https://custom.api.com/v1/messages');
    const headers = capturedOpts.headers;
    assert.equal(headers['x-api-key'], 'sk-test-123');
    assert.equal(headers['anthropic-version'], '2023-06-01');

    const body = JSON.parse(capturedOpts.body);
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.equal(body.max_tokens, 1024);
    assert.ok(body.messages.length > 0);
  });

  test('uses default baseUrl when not provided', async () => {
    let capturedUrl;
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'summary' }],
        }),
      };
    };

    await generateHandoffDigest({
      handoffSummaries,
      extractiveDigest,
      recentMessages,
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  });
});
