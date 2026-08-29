import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

const AUTH_ENV_KEYS = [
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_AGENT_KEY_SECRET',
  'CAT_CAFE_AGENT_KEY_FILE',
  'CAT_CAFE_AGENT_KEY_FILES',
  'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
  'CAT_CAFE_READONLY',
];

const originalEnv = Object.fromEntries(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));

function clearAuthEnv() {
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
}

function restoreAuthEnv() {
  for (const key of AUTH_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function postMessageTool(server) {
  const tool = server._registeredTools.cat_cafe_post_message;
  assert.ok(tool, 'post_message tool should be registered');
  return tool;
}

describe('post_message principal-specific public schema', () => {
  beforeEach(clearAuthEnv);
  afterEach(restoreAuthEnv);

  test('invocation-token registration omits threadId that runtime will reject', async () => {
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-schema-contract';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-schema-contract';

    const { createCollabServer } = await import('../dist/collab.js');
    const tool = postMessageTool(createCollabServer());

    assert.equal(
      Object.hasOwn(tool.inputSchema.shape, 'threadId'),
      false,
      'invocation callers must not be offered a threadId field that the handler rejects',
    );
    assert.ok(tool.inputSchema.shape.localReviewVerdict, 'invocation callers must receive typed verdict settlement');
    assert.ok(
      tool.inputSchema.shape.reviewedHeadSha,
      'invocation callers must be able to fence a carrier-free verdict',
    );
    assert.throws(
      () => tool.inputSchema.parse({ content: 'same-thread update', threadId: 'thread-current' }),
      /unrecognized key/i,
      'registration must reject forbidden threadId instead of silently stripping it before the handler fence',
    );
    assert.match(tool.description, /invocation-token registration uses the current thread and omits threadId/i);
  });

  test('agent-key-only registration requires threadId because there is no current invocation thread', async () => {
    process.env.CAT_CAFE_READONLY = 'true';
    process.env.CAT_CAFE_AGENT_KEY_SECRET = 'agent-key-schema-contract';

    const { createCollabServer } = await import('../dist/collab.js');
    const tool = postMessageTool(createCollabServer());
    const threadId = tool.inputSchema.shape.threadId;

    assert.ok(threadId, 'agent-key callers must be offered threadId');
    assert.equal(threadId.isOptional(), false, 'agent-key callers must see threadId as required');
    assert.ok(tool.inputSchema.shape.replyTo, 'agent-key callers must receive the source reply coordinate');
    assert.ok(
      tool.inputSchema.shape.cloudReturnBinding,
      'agent-key callers must receive the opaque source-bound return capability',
    );
    assert.ok(tool.inputSchema.shape.agentKeyCatId, 'shared agent-key servers must retain their identity selector');
    assert.equal(
      Object.hasOwn(tool.inputSchema.shape, 'localReviewVerdict'),
      false,
      'agent-key callers must not be offered invocation-bound local review settlement',
    );
    assert.equal(
      Object.hasOwn(tool.inputSchema.shape, 'reviewedHeadSha'),
      false,
      'agent-key callers must not be offered a reviewer-fact field without local review settlement',
    );
    assert.match(tool.description, /agent-key-only registration requires threadId/i);
  });

  test('complete invocation credentials win when agent-key credentials are also configured', async () => {
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-precedence-contract';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-precedence-contract';
    process.env.CAT_CAFE_AGENT_KEY_SECRET = 'agent-key-precedence-contract';

    const { createCollabServer } = await import('../dist/collab.js');
    const tool = postMessageTool(createCollabServer());

    assert.equal(
      Object.hasOwn(tool.inputSchema.shape, 'threadId'),
      false,
      'registration must follow the same invocation-first precedence as callback authentication',
    );
  });

  test('canonical cross-profile shape retains both principal capabilities', async () => {
    const { callbackTools, postMessageInputSchema } = await import('../dist/tools/callback-tools.js');
    const shapeKeys = Object.keys(postMessageInputSchema);

    assert.ok(shapeKeys.includes('threadId'), 'canonical shape must retain agent-key thread selection');
    assert.ok(postMessageInputSchema.threadId.isOptional(), 'registration projection owns principal-specific presence');
    assert.ok(shapeKeys.includes('agentKeyCatId'), 'canonical shape must retain persistent-agent selection');
    assert.ok(postMessageInputSchema.agentKeyCatId.isOptional());
    assert.ok(shapeKeys.includes('action'), 'canonical shape must retain same-thread structured successor action');
    assert.ok(postMessageInputSchema.action.isOptional());
    assert.ok(shapeKeys.includes('localReviewVerdict'), 'canonical shape must retain typed local verdict settlement');
    assert.ok(shapeKeys.includes('reviewedHeadSha'), 'canonical shape must retain the carrier-free exact-HEAD fence');
    assert.ok(
      shapeKeys.includes('streamDisposition'),
      'canonical shape must retain callback/final persistence semantics',
    );
    assert.equal(postMessageInputSchema.streamDisposition.parse(undefined), 'independent');
    assert.equal(postMessageInputSchema.streamDisposition.parse('replace_final'), 'replace_final');
    const definition = callbackTools.find((tool) => tool.name === 'cat_cafe_post_message');
    assert.ok(definition);
    assert.match(definition.description, /same-thread structured single successor/i);
    assert.match(definition.description, /streamDisposition="replace_final"/i);
    assert.match(definition.description, /multi_mention.*parallel/i);
  });
});
