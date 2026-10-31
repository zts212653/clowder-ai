import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

test('F326 project command is a canonical invocation-bound resource with strict named commands', async (t) => {
  const [{ CANONICAL_TOOL_REGISTRY }, tools] = await Promise.all([
    import('../dist/canonical-server-tools.js'),
    import('../dist/tools/content-modification-tools.js'),
  ]);
  const definition = CANONICAL_TOOL_REGISTRY.find((item) => item.name === 'cat_cafe_video_project_command');
  assert.ok(definition);
  assert.equal(definition.policy.resourceFamily, 'collaborative-content');
  assert.deepEqual(definition.policy.runtimeProfiles, ['full']);
  const schema = z.object(tools.videoProjectCommandInputSchema).strict();
  const input = { requestId: 'actual-takeover-request', command: { kind: 'read', cursor: 0 } };
  assert.equal(schema.safeParse(input).success, true);
  for (const command of [
    { kind: 'decide', answer: 'yes' },
    { kind: 'read', cursor: -1 },
    { kind: 'read', ownerRevision: 1.5 },
    { kind: 'save', expectedOwnerRevision: 2, operationId: 'edit', filePath: '/tmp/arbitrary.json' },
    { kind: 'save', expectedOwnerRevision: 2, operationId: 'edit' },
  ])
    assert.equal(schema.safeParse({ ...input, command }).success, false);
  assert.equal(schema.safeParse({ ...input, actor: 'human', userId: 'other-owner' }).success, false);
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    globalThis.fetch = fetch;
  });
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'actual-child';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'server-token';
  process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({ requestId: input.requestId, snapshot: 'sha256:exact', json: '{}', nextCursor: null }),
    };
  };
  const result = await tools.handleVideoProjectCommand(input);
  assert.equal(result.isError, undefined);
  assert.match(captured.url, /\/api\/callbacks\/video-project\/command$/);
  assert.deepEqual(JSON.parse(captured.options.body), input);
  assert.equal(captured.options.headers['x-invocation-id'], 'actual-child');
  assert.equal(captured.options.headers['x-callback-token'], 'server-token');
});
