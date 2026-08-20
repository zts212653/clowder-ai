import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('cat_cafe_record_proactive_memory_abstention MCP tool', () => {
  test('exposes a reason plus an optional content-free write-opportunity ref', async () => {
    const [{ callbackTools }, { proactiveMemoryAbstentionInputSchema }] = await Promise.all([
      import('../dist/tools/callback-tools.js'),
      import('@cat-cafe/shared'),
    ]);
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_record_proactive_memory_abstention');

    assert.ok(tool);
    assert.equal(tool.policy.activeState, 'canonical');
    assert.deepEqual(Object.keys(tool.inputSchema).sort(), ['reasonCode', 'writeOpportunityRef']);
    assert.equal('opportunityRef' in tool.inputSchema, false);
    assert.equal('threadId' in tool.inputSchema, false);
    assert.equal('messageId' in tool.inputSchema, false);
    const refObject = tool.inputSchema.writeOpportunityRef._def.innerType;
    assert.deepEqual(Object.keys(refObject._def.shape()).sort(), ['dedupeLineage', 'generation', 'opportunityId']);
    assert.equal(proactiveMemoryAbstentionInputSchema.safeParse({ reasonCode: 'anything_else' }).success, false);
  });

  test('posts the exact ref and returns a content-free recognized result', async () => {
    const { createProactiveMemoryAbstentionTool } = await import('../dist/tools/proactive-memory-opportunity-tool.js');
    const calls = [];
    const toolset = createProactiveMemoryAbstentionTool(async (path, body) => {
      calls.push({ path, body });
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'recorded' }) }] };
    });
    const writeOpportunityRef = {
      opportunityId: `write_opp_${'a'.repeat(32)}`,
      dedupeLineage: `write_lineage_${'b'.repeat(32)}`,
      generation: 1,
    };
    const result = await toolset.handleRecordProactiveMemoryAbstention({
      reasonCode: 'insufficient_owner_evidence',
      writeOpportunityRef,
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      {
        path: '/api/callbacks/record-proactive-memory-abstention',
        body: { reasonCode: 'insufficient_owner_evidence', writeOpportunityRef },
      },
    ]);
    assert.deepEqual(JSON.parse(result.content[0].text), { status: 'recorded' });
    assert.equal(result.content[0].text.includes('insufficient_owner_evidence'), false);
    assert.equal(result.content[0].text.includes('write_opp_'), false);
  });

  test('is explicitly annotated as a non-destructive callback write', async () => {
    const { EXPLICIT_TOOL_ANNOTATIONS } = await import('../dist/server-toolsets.js');

    assert.deepEqual(EXPLICIT_TOOL_ANNOTATIONS.cat_cafe_record_proactive_memory_abstention, {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

describe('cat_cafe_defer_person_memory_delta MCP tool', () => {
  test('accepts only subject, typed source coordinates, and a client request id', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_defer_person_memory_delta');

    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema).sort(), [
      'clientRequestId',
      'reentryReceipt',
      'sources',
      'subject',
      'writeOpportunityRef',
    ]);
    assert.equal('ownerUserId' in tool.inputSchema, false);
    assert.equal('threadId' in tool.inputSchema, false);
    assert.equal('privateBody' in tool.inputSchema, false);

    // writeOpportunityRef widened this surface on purpose, so the guard widens with an invariant
    // rather than just a longer key list: the ref is an identity triple only. If it ever grew a
    // subject, excerpt, or transcript field, a cat could launder payload in through the disposition
    // call, and the server re-derives every one of these from its own delivery evidence anyway.
    const refObject = tool.inputSchema.writeOpportunityRef._def.innerType; // unwrap ZodOptional
    assert.deepEqual(Object.keys(refObject._def.shape()).sort(), ['dedupeLineage', 'generation', 'opportunityId']);
    const reentryReceipt = tool.inputSchema.reentryReceipt._def.innerType;
    assert.deepEqual(Object.keys(reentryReceipt._def.shape()).sort(), ['claimId', 'receiptId']);
    assert.match(tool.description, /does not store message or transcript bodies/i);
    assert.match(tool.description, /known person/i);
    assert.match(tool.description, /daily/i);
  });

  test('posts exact coordinates and emits a recognized content-free defer outcome', async () => {
    const { createDeferredPersonMemoryTool } = await import('../dist/tools/proactive-memory-opportunity-tool.js');
    const calls = [];
    const toolset = createDeferredPersonMemoryTool(async (path, body) => {
      calls.push({ path, body });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              receiptId: 'deferred_person_0123456789abcdef0123456789abcdef',
              status: 'deferred',
              deduped: false,
            }),
          },
        ],
      };
    });
    const result = await toolset.handleDeferPersonMemoryDelta({
      subject: '黄挺',
      sources: [{ kind: 'message', messageId: 'msg_history' }],
      clientRequestId: 'defer-huang-ting-1',
    });

    assert.deepEqual(calls, [
      {
        path: '/api/callbacks/defer-person-memory',
        body: {
          subject: '黄挺',
          sources: [{ kind: 'message', messageId: 'msg_history' }],
          clientRequestId: 'defer-huang-ting-1',
        },
      },
    ]);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      receiptId: 'deferred_person_0123456789abcdef0123456789abcdef',
      status: 'deferred',
      deduped: false,
      proactiveMemoryOutcome: 'deferred_receipt_recorded',
    });
  });

  test('registers exact receipt withdraw and hard-forget lifecycle tools', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const withdraw = callbackTools.find((entry) => entry.name === 'cat_cafe_withdraw_deferred_person_memory');
    const forget = callbackTools.find((entry) => entry.name === 'cat_cafe_forget_deferred_person_memory');
    assert.deepEqual(Object.keys(withdraw.inputSchema), ['receiptId']);
    assert.deepEqual(Object.keys(forget.inputSchema), ['receiptId']);
    assert.match(forget.description, /destructive/i);

    const { createDeferredPersonMemoryTool } = await import('../dist/tools/proactive-memory-opportunity-tool.js');
    const calls = [];
    const toolset = createDeferredPersonMemoryTool(async (path, body) => {
      calls.push({ path, body });
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'purged' }) }] };
    });
    const input = { receiptId: 'deferred_person_0123456789abcdef0123456789abcdef' };
    await toolset.handleWithdrawDeferredPersonMemory(input);
    await toolset.handleForgetDeferredPersonMemory(input);

    assert.deepEqual(calls, [
      { path: '/api/callbacks/person-memory/deferred/withdraw', body: input },
      { path: '/api/callbacks/person-memory/deferred/forget', body: input },
    ]);
  });
});
