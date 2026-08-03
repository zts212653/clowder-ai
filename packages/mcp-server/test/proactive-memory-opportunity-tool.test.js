import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('cat_cafe_record_proactive_memory_abstention MCP tool', () => {
  test('exposes exactly one enum-only reasonCode input', async () => {
    const [{ callbackTools }, { proactiveMemoryAbstentionInputSchema }] = await Promise.all([
      import('../dist/tools/callback-tools.js'),
      import('@cat-cafe/shared'),
    ]);
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_record_proactive_memory_abstention');

    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema), ['reasonCode']);
    assert.equal('opportunityRef' in tool.inputSchema, false);
    assert.equal('threadId' in tool.inputSchema, false);
    assert.equal('messageId' in tool.inputSchema, false);
    assert.equal(
      proactiveMemoryAbstentionInputSchema.safeParse({
        reasonCode: 'bad_timing',
        opportunityRef: 'opp_0123456789abcdef0123456789abcdef',
      }).success,
      false,
    );
    assert.equal(proactiveMemoryAbstentionInputSchema.safeParse({ reasonCode: 'anything_else' }).success, false);
  });

  test('returns a content-free recognized result without calling a callback', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_record_proactive_memory_abstention');

    const result = await tool.handler({ reasonCode: 'insufficient_owner_evidence' });

    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { status: 'recorded' });
    assert.equal(result.content[0].text.includes('insufficient_owner_evidence'), false);
    assert.equal(result.content[0].text.includes('opp_'), false);
  });

  test('is explicitly annotated as a local non-destructive write', async () => {
    const { EXPLICIT_TOOL_ANNOTATIONS } = await import('../dist/server-toolsets.js');

    assert.deepEqual(EXPLICIT_TOOL_ANNOTATIONS.cat_cafe_record_proactive_memory_abstention, {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
