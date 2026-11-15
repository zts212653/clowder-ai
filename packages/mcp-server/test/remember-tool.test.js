import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { handleRemember, rememberTools } from '../dist/tools/remember-tool.js';

const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];
let saved, originalFetch, requests;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  originalFetch = globalThis.fetch;
  requests = [];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'remember-test';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'remember-test-token';
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: true,
      json: async () => ({
        groupId: 'remember-example',
        results: [{ itemId: 'one', statusCode: 422, result: { error: 'source_not_eligible' } }],
      }),
    };
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('remember makes one authenticated callback with original payloads and returns per-item refusals unchanged', async () => {
  const items = [
    {
      itemId: 'one',
      target: 'profile',
      payload: {
        afterContent: '新内容',
        rationale: '主人明确要求',
        signalKind: 'cvo-instructed',
        targetLayer: 'corpus',
        clientRequestId: 'original-key',
      },
    },
  ];
  const result = await handleRemember({ clientRequestId: 'group-key', items });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/callbacks\/remember$/);
  assert.deepEqual(requests[0].body, { clientRequestId: 'group-key', items });
  assert.equal(requests[0].headers['x-invocation-id'], 'remember-test');
  assert.equal(JSON.parse(result.content[0].text).results[0].result.error, 'source_not_eligible');
});
// 2026-11-13 You：旧写工具从猫的工具面撤掉，全走 remember。
test('remember is the only memory write entry on every canonical surface', async () => {
  const { CANONICAL_TOOL_REGISTRY } = await import('../dist/server-toolsets.js');
  const { projectCanonicalToolRegistry } = await import('../dist/canonical-tool-registry.js');
  const byName = new Map(CANONICAL_TOOL_REGISTRY.map((tool) => [tool.name, tool]));
  assert.ok(
    projectCanonicalToolRegistry(CANONICAL_TOOL_REGISTRY, {}).some((tool) => tool.name === 'cat_cafe_remember'),
  );
  for (const name of [
    'cat_cafe_propose_profile_update', // mcp-cutover-negative-reference: absence
    'cat_cafe_propose_taste', // mcp-cutover-negative-reference: absence
    'cat_cafe_write_memory_matter', // mcp-cutover-negative-reference: absence
  ])
    assert.equal(byName.has(name), false, name);
  assert.equal(
    CANONICAL_TOOL_REGISTRY.some((tool) => tool.policy.runtimeProfiles.includes('watcher')),
    false,
  );
});

test('each remember target carries its own payload schema', () => {
  const schema = z.object(rememberTools[0].inputSchema);
  const taste = {
    itemId: 'one',
    target: 'taste',
    payload: {
      scene: '评审',
      quote: '太客服了',
      tags: ['活人感'],
      dimension: 'authentic-expression',
      privacy: 'public',
    },
  };
  assert.equal(schema.safeParse({ items: [taste] }).success, true);
  assert.equal(schema.safeParse({ items: [] }).success, false);
  assert.equal(schema.safeParse({ items: Array(5).fill(taste) }).success, false);
  assert.equal(schema.safeParse({ items: [{ ...taste, target: 'forget' }] }).success, false);
  assert.equal(
    schema.safeParse({ items: [{ ...taste, payload: { ...taste.payload, unknownField: 1 } }] }).success,
    false,
  );
  const profile = { itemId: 'p', target: 'profile', payload: { afterContent: 'x', rationale: 'y' } };
  assert.equal(schema.safeParse({ items: [profile] }).success, false, 'profile needs signalKind');
  const abstain = { itemId: 'a', target: 'person_abstain', payload: { reasonCode: 'bad_timing' } };
  assert.equal(schema.safeParse({ items: [abstain] }).success, true);
  const abstainWithText = { ...abstain, payload: { reasonCode: 'bad_timing', note: '原文' } };
  assert.equal(schema.safeParse({ items: [abstainWithText] }).success, false);
});

test('remember preserves all profile layers, source coordinates and a Taste correction payload without exposing callback credentials', async () => {
  const profiles = ['primer', 'corpus', 'capsule'].map((targetLayer) => ({
    itemId: targetLayer,
    target: 'profile',
    payload: {
      afterContent: '原文',
      rationale: '原理由',
      signalKind: 'cvo-instructed',
      targetLayer,
      sourceMessageId: 'source',
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      clientRequestId: `profile-${targetLayer}`,
    },
  }));
  const correction = {
    itemId: 'taste',
    target: 'taste',
    payload: {
      target: {
        sourceAnchor: 'taste-vignette:docs/taste/vignettes/example.md',
        expectedRevision: `sha256:${'a'.repeat(64)}`,
        reason: 'outdated',
        suggestedPatch: { takeaway: '更正后的判断' },
      },
      clientRequestId: 'correction-request-key-with-32-characters',
    },
  };
  const items = [...profiles, correction];
  assert.equal(z.object(rememberTools[0].inputSchema).safeParse({ items }).success, true);
  await handleRemember({ items });
  assert.deepEqual(requests[0].body.items, items);
  assert.match(requests[0].body.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(requests[0].headers['x-callback-token'], 'remember-test-token');
  assert.equal('callbackToken' in requests[0].body, false);
  assert.equal('invocationId' in requests[0].body, false);
});

test('the person target keeps the F276 guidance and excludes owner identity fields', () => {
  const tool = rememberTools[0];
  const person = z
    .object(tool.inputSchema)
    .shape.items.element.options.find((option) => option.shape.target.value === 'person');
  const payload = person.shape.payload;
  assert.equal('ownerUserId' in payload.shape, false);
  assert.ok('writeOpportunityRef' in payload.shape);
  const description = payload.description;
  for (const phrase of [
    /replacesProposalId/,
    /Never route a private-memory correction into workspace Entity/,
    /stay in the current conversation/i,
    /typed sources/i,
    /drills to its original thread/i,
    /zero-information card/i,
    /never model the correction itself as a new interaction event/i,
    /before the first durable write/i,
    /machine-readable preflight action/i,
    /complete new pending snapshot/i,
    /different replacesProposalId fails closed/i,
  ])
    assert.match(description, phrase);
  const entity = z
    .object(tool.inputSchema)
    .shape.items.element.options.find((option) => option.shape.target.value === 'entity');
  assert.match(entity.shape.payload.description, /correcting a pending\/private F276 card is not an Entity mutation/);
});

test('tools/list projects the person temporal union inline inside remember', async () => {
  const [{ createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    import('../dist/index.js'),
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
  ]);
  const server = createServer();
  const client = new Client({ name: 'remember-schema-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === 'cat_cafe_remember');
    const variants = tool.inputSchema.properties.items.items.anyOf;
    assert.deepEqual(
      variants.map((variant) => variant.properties.target.const),
      [
        'profile',
        'taste',
        'person',
        'person_defer',
        'person_abstain',
        'entity',
        'event_correction',
        'matter',
        'person_revision',
      ],
    );
    const person = variants.find((variant) => variant.properties.target.const === 'person');
    const interaction = person.properties.payload.properties.interaction.properties.payload;
    for (const field of ['occurredAt', 'duration']) {
      const temporal = interaction.properties[field];
      assert.ok(Array.isArray(temporal.anyOf), `${field} must be projected inline, not as any or $ref`);
      assert.deepEqual(
        temporal.anyOf.map((branch) => branch.properties.kind.const),
        ['exact', 'approximate', 'conflict'],
      );
      assert.equal('$ref' in temporal, false);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
