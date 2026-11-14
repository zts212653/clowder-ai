import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// 2026-11-13: defer and abstention moved into cat_cafe_remember (targets person_defer / person_abstain).
describe('proactive-memory tools left on the cat surface', () => {
  test('defer and abstention are no longer standalone tools', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const names = new Set(callbackTools.map((entry) => entry.name));
    assert.equal(names.has('cat_cafe_record_proactive_memory_abstention'), false); // mcp-cutover-negative-reference: absence
    assert.equal(names.has('cat_cafe_defer_person_memory_delta'), false); // mcp-cutover-negative-reference: absence
  });

  test('retains the exact clerk disposition and retires owner receipt cleanup tools', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const dispose = callbackTools.find((entry) => entry.name === 'cat_cafe_dispose_deferred_person_memory');
    const withdraw = callbackTools.find((entry) => entry.name === 'cat_cafe_withdraw_deferred_person_memory'); // mcp-cutover-negative-reference: absence
    const forget = callbackTools.find((entry) => entry.name === 'cat_cafe_forget_deferred_person_memory'); // mcp-cutover-negative-reference: absence
    assert.deepEqual(Object.keys(dispose.inputSchema).sort(), [
      'claimId',
      'disposition',
      'receiptId',
      'writeOpportunityRef',
    ]);
    assert.equal(withdraw, undefined);
    assert.equal(forget, undefined);

    const { createDeferredPersonMemoryTool } = await import('../dist/tools/proactive-memory-opportunity-tool.js');
    const calls = [];
    const toolset = createDeferredPersonMemoryTool(async (path, body) => {
      calls.push({ path, body });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              path.endsWith('/dispose')
                ? { receiptId: body.receiptId, status: 'not_actionable' }
                : { status: 'purged' },
            ),
          },
        ],
      };
    });
    const input = { receiptId: 'deferred_person_0123456789abcdef0123456789abcdef' };
    const disposition = { ...input, claimId: 'claim-1', disposition: 'insufficient_evidence' };
    const dispositionResult = await toolset.handleDisposeDeferredPersonMemory(disposition);
    assert.deepEqual(calls, [{ path: '/api/callbacks/person-memory/deferred/dispose', body: disposition }]);
    assert.deepEqual(JSON.parse(dispositionResult.content[0].text), {
      receiptId: input.receiptId,
      status: 'not_actionable',
    });

    const { EXPLICIT_TOOL_ANNOTATIONS } = await import('../dist/server-toolsets.js');
    assert.deepEqual(EXPLICIT_TOOL_ANNOTATIONS.cat_cafe_dispose_deferred_person_memory, {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
