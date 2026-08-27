import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

describe('F292 meeting artifact MCP reader', () => {
  afterEach(() => mock.restoreAll());

  it('sends only the versioned ref, explicit bounds, cursor, and filters through callback auth', async () => {
    const prior = {
      apiUrl: process.env.CAT_CAFE_API_URL,
      invocationId: process.env.CAT_CAFE_INVOCATION_ID,
      callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN,
    };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3999';
    process.env.CAT_CAFE_INVOCATION_ID = 'invocation-f292';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-f292';
    const calls = [];
    mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ content: 'bounded', nextCursor: 'next' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const { handleReadMeetingArtifact } = await import('../dist/tools/meeting-artifact-tools.js');
      const result = await handleReadMeetingArtifact({
        resourceRef: 'meeting-artifact://intakes/intake-1?revision=sha256:abc',
        view: 'content',
        maxChars: 800,
        maxTokens: 200,
        cursor: 'cursor-1',
        speakers: ['Alice'],
      });
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://127.0.0.1:3999/api/callbacks/meeting-artifacts/read');
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body, {
        resourceRef: 'meeting-artifact://intakes/intake-1?revision=sha256:abc',
        view: 'content',
        maxChars: 800,
        maxTokens: 200,
        cursor: 'cursor-1',
        speakers: ['Alice'],
      });
      assert.equal('transcript' in body, false);
    } finally {
      for (const [key, value] of Object.entries({
        CAT_CAFE_API_URL: prior.apiUrl,
        CAT_CAFE_INVOCATION_ID: prior.invocationId,
        CAT_CAFE_CALLBACK_TOKEN: prior.callbackToken,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('registers as a bounded, revision-fenced read tool', async () => {
    const { createServer } = await import('../dist/index.js');
    const tool = createServer()._registeredTools.cat_cafe_read_meeting_artifact;
    assert.ok(tool);
    assert.match(tool.description, /data_only\/untrusted_external/);
    assert.match(tool.description, /source revision change fails closed/);
    assert.equal(tool.inputSchema._def.shape().maxChars.isOptional(), false);
    assert.equal(tool.inputSchema._def.shape().maxTokens.isOptional(), false);
    assert.equal(tool.inputSchema._def.shape().agentKeyCatId.isOptional(), true);
  });
});
