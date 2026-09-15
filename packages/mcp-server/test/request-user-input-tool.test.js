import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, beforeEach, describe, test } from 'node:test';

const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const questions = [
  { header: 'Permission', question: 'May I continue authorized work?', options: [{ label: 'Yes' }, { label: 'No' }] },
];

describe('retired blocking question tool', () => {
  beforeEach(() => {
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3012';
    process.env.CAT_CAFE_INVOCATION_ID = 'retirement-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'retirement-test';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });
  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  test('returns guidance without network, a human card, or approval', async () => {
    const { handleRequestUserInput } = await import('../dist/tools/runtime-interaction-tools.js');
    let networkCalls = 0;
    const result = await handleRequestUserInput(
      { questions },
      {
        transport: async () => {
          networkCalls += 1;
          return { statusCode: 200, body: JSON.stringify({ response: { kind: 'answers', answers: { q1: ['Yes'] } } }) };
        },
      },
    );
    assert.equal(networkCalls, 0);
    const notice = JSON.parse(result.content[0].text);
    assert.equal(notice.status, 'retired');
    assert.equal(notice.approvalGranted, false);
    assert.equal(notice.questionCreated, false);
    assert.equal(notice.response, undefined);
    assert.match(notice.message, /already.authorized/i);
    assert.match(notice.message, /not.*approval/i);
  });

  test('the compatibility notice needs no invocation credentials or live host', async () => {
    for (const key of keys) delete process.env[key];
    const { handleRequestUserInput } = await import('../dist/tools/runtime-interaction-tools.js');
    const result = await handleRequestUserInput({ questions });
    assert.equal(JSON.parse(result.content[0].text).status, 'retired');
  });

  test('SDK dispatch of the cached name never reaches a live callback endpoint', async () => {
    let requests = 0;
    const callback = createHttpServer((_request, response) => {
      requests += 1;
      response.end(JSON.stringify({ response: { kind: 'answers', answers: { q1: ['Yes'] } } }));
    });
    await new Promise((resolve) => callback.listen(0, '127.0.0.1', resolve));
    const address = callback.address();
    assert.ok(address && typeof address !== 'string');
    process.env.CAT_CAFE_API_URL = `http://127.0.0.1:${address.port}`;
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    try {
      const result = await server._registeredTools.cat_cafe_request_user_input.handler(
        { questions },
        { signal: new AbortController().signal },
      );
      assert.equal(requests, 0);
      assert.equal(JSON.parse(result.content[0].text).status, 'retired');
    } finally {
      await server.close();
      callback.closeAllConnections();
      await new Promise((resolve, reject) => callback.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test('the advertised entry explains retirement and never invites a blocking question', async () => {
    const { CANONICAL_TOOL_REGISTRY } = await import('../dist/server-toolsets.js');
    const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === 'cat_cafe_request_user_input');
    assert.ok(tool);
    assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
    assert.match(tool.description, /retired/i);
    assert.match(tool.description, /NOT for.*approval/i);
    assert.doesNotMatch(tool.description, /Pause this ordinary|resume this same tool call/);
    assert.equal(tool.annotations.readOnlyHint, true);
  });
});
