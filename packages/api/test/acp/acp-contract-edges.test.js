import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAcpPacket } from '../../dist/domains/cats/services/agents/providers/acp/protocol/acp-request-dispatcher.js';
import { AcpPromptUsageTracker } from '../../dist/domains/cats/services/agents/providers/acp/protocol/acp-usage.js';
import { imageFixture } from '../helpers/acp-image-fixture.js';

const NS = 'clowder.ai/acp.v1';
const init = (caps) => ({ protocolVersion: 1, agentCapabilities: caps });
for (const transport of ['stdio', 'http']) {
  test(`${transport}: numeric zero and string zero agent IDs remain distinct`, async () => {
    const f = await imageFixture(transport, '/fixture', {
      agentPackets: [0, '0'].map((id) => ({ jsonrpc: '2.0', id, method: 'unknown/synthetic', params: {} })),
    });
    try {
      for await (const _ of f.client.promptStream('native', 'Synthetic')) {
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.captured.filter((p) => p.id === 0 && p.error?.code === -32601).length, 1);
      assert.equal(f.captured.filter((p) => p.id === '0' && p.error?.code === -32601).length, 1);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: close is negotiated per-session and retires that session only`, async () => {
    const f = await imageFixture(transport, '/fixture', {
      initializeResult: init({ sessionCapabilities: { close: {} } }),
    });
    try {
      await f.client.closeSession('native');
      assert.equal(f.captured.filter((p) => p.method === 'session/close').length, 1);
      await assert.rejects(async () => {
        for await (const _ of f.client.promptStream('native', 'Synthetic')) {
        }
      }, /closed|retired/);
      assert.equal(f.client.isAlive, true);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: required MCP absent from resolved list cannot silently succeed`, async () => {
    const f = await imageFixture(transport, '/fixture');
    try {
      await assert.rejects(f.client.newSession('/fixture', [], { requiredMcpServers: ['missing'] }), /required|MCP/i);
      assert.equal(f.captured.filter((p) => p.method === 'session/new').length, 0);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: unnegotiated execution extension is never probed`, async () => {
    const f = await imageFixture(transport, '/fixture');
    try {
      await assert.rejects(f.client.readExecutionBinding('native'), /negotiated|execution/);
      assert.equal(f.captured.filter((p) => p.method === '_clowder/v1/execution/read').length, 0);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: execution receipt is scoped, typed and excludes arbitrary secrets`, async () => {
    const f = await imageFixture(transport, '/fixture', {
      initializeResult: init({
        _meta: { [NS]: { contractVersion: 1, methods: { '_clowder/v1/execution/read': true } } },
      }),
      executionResult: {
        sessionId: 'native',
        bindingFingerprint: 'a'.repeat(64),
        nativeExecutable: { sha256: 'b'.repeat(64), version: 'synthetic' },
        accountFingerprint: 'c'.repeat(64),
        policyFingerprint: 'd'.repeat(64),
        privateAuth: 'SyntheticSecret',
      },
    });
    try {
      const receipt = await f.client.readExecutionBinding('native');
      assert.equal(receipt.bindingFingerprint, 'a'.repeat(64));
      assert.equal(receipt.verification, 'bridge_reported');
      assert.equal(JSON.stringify(receipt).includes('SyntheticSecret'), false);
    } finally {
      await f.close();
    }
  });
}
test('stdio response IDs have typed correlation without string coercion', async () => {
  const f = await imageFixture('stdio', '/fixture', {
    packetTransform: (packets, request) =>
      request.method === 'synthetic' ? packets.map((p) => ({ ...p, result: { value: typeof request.id } })) : packets,
  });
  try {
    const [numeric, text] = await Promise.all([
      f.client.sendRequest('synthetic', {}, 500, 0),
      f.client.sendRequest('synthetic', {}, 500, '0'),
    ]);
    assert.equal(numeric.result.value, 'number');
    assert.equal(text.result.value, 'string');
  } finally {
    await f.close();
  }
});
test('HTTP rejects a valid envelope belonging to another request', async () => {
  await assert.rejects(
    imageFixture('http', '/fixture', { packetTransform: (packets) => packets.map((p) => ({ ...p, id: 'foreign' })) }),
    /ID mismatch/,
  );
});
test('unknown fields survive but conflicting or missing JSON-RPC authority does not', () => {
  const raw = { jsonrpc: '2.0', id: 0, result: {}, _meta: { future: { rawRef: 'synthetic:opaque' } } };
  assert.deepEqual(classifyAcpPacket(raw).response, raw);
  assert.equal(classifyAcpPacket({ ...raw, error: { code: 1, message: 'conflict' } }).kind, 'invalid');
  assert.equal(classifyAcpPacket({ ...raw, jsonrpc: '1.0' }).kind, 'invalid');
});
test('unknown prompt token scope never claims invocation cost or context', () => {
  assert.equal(
    new AcpPromptUsageTracker().accept({ stopReason: 'end_turn', usage: { inputTokens: 100 } }).usage,
    undefined,
  );
});
test('reserved usage metadata cannot promote scope before initialize negotiation', () => {
  assert.equal(
    new AcpPromptUsageTracker().accept({
      stopReason: 'end_turn',
      usage: { inputTokens: 5 },
      _meta: { [NS]: { usage: { scope: 'prompt', kind: 'snapshot' } } },
    }).usage,
    undefined,
  );
});
test('explicit prompt snapshots replace; identified deltas add once; negative values never enter totals', () => {
  const tracker = new AcpPromptUsageTracker();
  tracker.bind('native', true);
  const result = (kind, count, id) => ({
    stopReason: 'end_turn',
    usage: { inputTokens: count },
    _meta: { [NS]: { usage: { scope: 'prompt', kind, id } } },
  });
  assert.equal(tracker.accept(result('snapshot', 5)).usage.inputTokens, 5);
  assert.equal(tracker.accept(result('snapshot', 5)).usage.inputTokens, 5);
  assert.equal(tracker.accept(result('delta', 2, 'native-event-1')).usage.inputTokens, 7);
  assert.equal(tracker.accept(result('delta', 2, 'native-event-1')).usage.inputTokens, 7);
  assert.equal(tracker.accept(result('delta', -1, 'native-event-2')).usage.inputTokens, 7);
  assert.equal(tracker.accept(result('delta', 3)).usage, undefined);
});
