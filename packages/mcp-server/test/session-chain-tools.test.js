import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('F324: raw session events bound the complete MCP page and expose a real next event', async () => {
  const { handleReadSessionEvents } = await import('../dist/tools/session-chain-tools.js');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      events: Array.from({ length: 200 }, (_, eventNo) => ({
        eventNo,
        event: { type: 'text', content: `event-${eventNo}-${'x'.repeat(400)}` },
      })),
      nextCursor: { eventNo: 200 },
      total: 1_000,
    }),
  });
  const result = await handleReadSessionEvents({ sessionId: 'sealed', view: 'raw', cursor: 0, limit: 200 });
  const text = result.content[0].text;
  assert.ok(text.length <= 24_000, `rendered ${text.length} chars`);
  assert.match(text, /event-0-x{400}/, 'ordinary event remains complete');
  assert.match(text, /Next cursor: ([1-9]\d*)/);
  assert.ok(Number(text.match(/Next cursor: (\d+)/)[1]) < 200, 'local omission must resume at first omitted event');
});

test('F324: oversized raw event points to exact session event character slices', async () => {
  const { handleReadSessionEvents } = await import('../dist/tools/session-chain-tools.js');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ events: [{ eventNo: 7, event: { type: 'text', content: 'z'.repeat(250_000) } }], total: 8 }),
  });
  const result = await handleReadSessionEvents({ sessionId: 'sealed', view: 'raw', cursor: 7, limit: 1 });
  const text = result.content[0].text;
  assert.ok(text.length <= 24_000);
  assert.match(text, /cursor=7.*charOffset=0/);
  assert.match(text, /oversized/i);
});

test('F324: invocation detail pages by source event number without silent 300-char cuts', async () => {
  const { handleReadInvocationDetail } = await import('../dist/tools/session-chain-tools.js');
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        invocationId: 'inv-1',
        events: Array.from({ length: 200 }, (_, eventNo) => ({
          eventNo,
          event: { type: 'text', content: `event-${eventNo}-${'q'.repeat(400)}` },
        })),
        total: 1_000,
        nextCursor: { eventNo: 200 },
      }),
    };
  };
  const result = await handleReadInvocationDetail({
    sessionId: 'sealed',
    invocationId: 'inv-1',
    cursor: 0,
    limit: 200,
  });
  const text = result.content[0].text;
  assert.ok(requestedUrl.includes('limit=200'));
  assert.ok(text.length <= 24_000);
  assert.match(text, /event-0-q{400}/);
  assert.match(text, /Next cursor: ([1-9]\d*)/);
});

test('F324: list session chain requests a bounded source page with an offset', async () => {
  const { handleListSessionChain } = await import('../dist/tools/session-chain-tools.js');
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({ sessions: [{ id: 'session-11', status: 'sealed' }], hasMore: true, nextOffset: 11 }),
    };
  };
  const result = await handleListSessionChain({ threadId: 'thread-1', limit: 1, offset: 10 });
  assert.ok(requestedUrl.includes('limit=1'));
  assert.ok(requestedUrl.includes('offset=10'));
  assert.match(result.content[0].text, /nextOffset.*11/);
});

test('F324: read digest follows an exact bounded character continuation', async () => {
  const { handleReadSessionDigest } = await import('../dist/tools/session-chain-tools.js');
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ digestSlice: 'abcd', charOffset: 8, totalChars: 20, nextCharOffset: 12 }) };
  };
  const result = await handleReadSessionDigest({ sessionId: 'sealed', charOffset: 8 });
  assert.ok(requestedUrl.includes('charOffset=8'));
  assert.match(result.content[0].text, /abcd/);
  assert.match(result.content[0].text, /charOffset=12/);
});

test('F324: chat page uses event numbers and does not silently cut ordinary content', async () => {
  const { handleReadSessionEvents } = await import('../dist/tools/session-chain-tools.js');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      messages: Array.from({ length: 200 }, (_, eventNo) => ({
        eventNo,
        role: 'assistant',
        content: `chat-${eventNo}-${'x'.repeat(400)}`,
      })),
      nextCursor: { eventNo: 200 },
      total: 1_000,
    }),
  });
  const result = await handleReadSessionEvents({ sessionId: 'sealed', view: 'chat', limit: 200 });
  const text = result.content[0].text;
  assert.ok(text.length <= 24_000);
  assert.match(text, /chat-0-x{400}/);
  assert.match(text, /Next cursor: ([1-9]\d*)/);
});

test('F324: oversized handoff summary points to invocation detail', async () => {
  const { handleReadSessionEvents } = await import('../dist/tools/session-chain-tools.js');
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      invocations: [
        {
          invocationId: 'inv-huge',
          eventCount: 1_000,
          toolCalls: Array.from({ length: 1_000 }, (_, i) => `tool-${i}`),
          errors: 0,
          durationMs: 1_000,
          keyMessages: [],
        },
      ],
      total: 1_000,
    }),
  });
  const result = await handleReadSessionEvents({ sessionId: 'sealed', view: 'handoff' });
  const text = result.content[0].text;
  assert.ok(text.length <= 24_000);
  assert.match(text, /inv-huge/);
  assert.match(text, /cat_cafe_read_invocation_detail/);
});

test('F324 Phase B: session-chain schema describes the authenticated self-only cat boundary', async () => {
  const { listSessionChainInputSchema, sessionChainTools } = await import('../dist/tools/session-chain-tools.js');
  const catIdDescription = listSessionChainInputSchema.catId.description ?? '';
  const toolDescription =
    sessionChainTools.find((tool) => tool.name === 'cat_cafe_list_session_chain')?.description ?? '';

  assert.match(catIdDescription, /current authenticated cat|当前已认证猫/i);
  assert.doesNotMatch(catIdDescription, /any valid registered catId/i);
  assert.match(toolDescription, /peer raw sessions.*forbidden|不允许读取其他猫.*原始会话/i);
});
