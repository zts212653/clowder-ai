import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('cat_cafe_propose_person_memory MCP tool', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('posts a bounded person proposal and generates an idempotency key', async () => {
    const { handleProposePersonMemory } = await import('../dist/tools/callback-tools.js');
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({
          candidateId: 'person_candidate_1',
          status: 'pending_approval',
          messageId: 'card_1',
        }),
      };
    };

    const writeOpportunityRef = {
      opportunityId: `write_opp_${'a'.repeat(32)}`,
      dedupeLineage: `write_lineage_${'b'.repeat(32)}`,
      generation: 1,
    };
    const result = await handleProposePersonMemory({
      person: { displayName: '黄挺', privateAliases: ['黄挺'] },
      replacesProposalId: 'person_candidate_stale',
      claims: [
        {
          payload: {
            kind: 'reported_fact',
            predicate: 'organization_unit',
            value: '终端用户计算开发部',
            assertedBy: 'owner',
          },
          normalizedDraft: '黄挺属于终端用户计算开发部',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
        },
      ],
      sourceBundle: {
        sources: [
          {
            sourceId: 'source-claim-0',
            kind: 'message_text',
            messageId: 'msg_people',
            excerpt: '黄挺是终端用户计算开发部 21 级',
          },
        ],
        assertionBindings: [
          {
            sourceId: 'source-claim-0',
            target: { kind: 'claim', index: 0 },
            role: 'reported_fact',
          },
        ],
      },
      sourceMessageId: 'msg_people',
      writeOpportunityRef,
    });

    assert.equal(result.isError, undefined);
    assert.match(captured.url, /\/api\/callbacks\/propose-person-memory$/);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.person.displayName, '黄挺');
    assert.equal(body.claims.length, 1);
    assert.equal(body.sourceBundle.sources[0].kind, 'message_text');
    assert.equal(body.sourceBundle.assertionBindings[0].role, 'reported_fact');
    assert.equal(body.replacesProposalId, 'person_candidate_stale');
    assert.deepEqual(body.writeOpportunityRef, writeOpportunityRef);
    assert.equal(typeof body.clientRequestId, 'string');
    assert.equal(body.invocationId, undefined);
    assert.equal(body.callbackToken, undefined);
  });

  test('registers the tool and excludes any ownerUserId field', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_propose_person_memory');
    assert.ok(tool);
    assert.equal('ownerUserId' in tool.inputSchema, false);
    assert.ok('writeOpportunityRef' in tool.inputSchema);
    const refObject = tool.inputSchema.writeOpportunityRef._def.innerType;
    assert.deepEqual(Object.keys(refObject._def.shape()).sort(), ['dedupeLineage', 'generation', 'opportunityId']);
    assert.equal(typeof tool.handler, 'function');
  });

  test('routes pending private-memory corrections through F276 instead of workspace Entity', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const personTool = callbackTools.find((entry) => entry.name === 'cat_cafe_propose_person_memory');
    const entityTool = callbackTools.find((entry) => entry.name === 'cat_cafe_propose_entity');
    assert.match(personTool.description, /replacesProposalId/);
    assert.match(personTool.description, /never route a private-memory correction into workspace Entity/);
    assert.match(personTool.description, /stay in the current conversation/i);
    assert.match(personTool.description, /typed sources/i);
    assert.match(personTool.description, /drills to its original thread/i);
    assert.match(personTool.description, /zero-information card/i);
    assert.match(personTool.description, /never model the correction itself as a new interaction event/i);
    assert.match(personTool.description, /before the first durable write/i);
    assert.match(personTool.description, /machine-readable preflight action/i);
    assert.match(personTool.description, /complete new pending snapshot/i);
    assert.match(personTool.description, /different replacesProposalId fails closed/i);
    assert.match(entityTool.description, /correcting a pending\/private F276 card is not an Entity mutation/);
  });

  test('projects both temporal fields as the concrete shared union in tools/list', async () => {
    const [{ createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
      import('../dist/index.js'),
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
    ]);
    const server = createServer();
    const client = new Client({ name: 'f276-schema-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === 'cat_cafe_propose_person_memory');
      const payload = tool.inputSchema.properties.interaction.properties.payload;
      for (const field of ['occurredAt', 'duration']) {
        const temporal = payload.properties[field];
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
});
