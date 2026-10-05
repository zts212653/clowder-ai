import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.CAT_CAFE_API_URL;
const originalAgentKey = process.env.CAT_CAFE_AGENT_KEY_SECRET;
const originalAgentKeyFile = process.env.CAT_CAFE_AGENT_KEY_FILE;
const originalAgentKeyFiles = process.env.CAT_CAFE_AGENT_KEY_FILES;
beforeEach(() => {
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
  process.env.CAT_CAFE_AGENT_KEY_SECRET = 'test-agent-key';
  delete process.env.CAT_CAFE_AGENT_KEY_FILE;
  delete process.env.CAT_CAFE_AGENT_KEY_FILES;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
  else process.env.CAT_CAFE_API_URL = originalApiUrl;
  if (originalAgentKey === undefined) delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
  else process.env.CAT_CAFE_AGENT_KEY_SECRET = originalAgentKey;
  if (originalAgentKeyFile === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILE;
  else process.env.CAT_CAFE_AGENT_KEY_FILE = originalAgentKeyFile;
  if (originalAgentKeyFiles === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILES;
  else process.env.CAT_CAFE_AGENT_KEY_FILES = originalAgentKeyFiles;
});

test('F324: canonical Event Memory tool exposes exact giant-record continuation', async () => {
  const { eventMemoryTools, handleListEvents } = await import('../dist/tools/event-memory-tools.js');
  const tool = eventMemoryTools.find((item) => item.name === 'cat_cafe_list_events');
  assert.ok(tool.inputSchema.eventId, 'MCP caller needs an eventId detail input');
  assert.ok(tool.inputSchema.charOffset, 'MCP caller needs an exact offset input');
  assert.doesNotMatch(tool.description, /default unbounded/);

  const source = JSON.stringify({ eventId: 'event-1', summary: 'x'.repeat(250_000) });
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const offset = Number(new URL(String(url)).searchParams.get('charOffset'));
    const eventSlice = source.slice(offset, offset + 8_000);
    const nextCharOffset = offset + eventSlice.length;
    return {
      ok: true,
      json: async () => ({
        eventSlice,
        charOffset: offset,
        totalChars: source.length,
        ...(nextCharOffset < source.length ? { nextCharOffset } : {}),
      }),
    };
  };

  let offset = 0;
  let recovered = '';
  for (let page = 0; page < 40; page += 1) {
    const result = await handleListEvents({ eventId: 'event-1', charOffset: offset });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.length <= 24_000);
    const body = JSON.parse(result.content[0].text);
    recovered += body.eventSlice;
    if (body.nextCharOffset === undefined) break;
    offset = body.nextCharOffset;
  }
  assert.ok(requests.every((url) => new URL(url).pathname === '/api/memory/events/event-1'));
  assert.equal(createHash('sha256').update(recovered).digest('hex'), createHash('sha256').update(source).digest('hex'));
});

test('F324: Event detail and list filters are mutually exclusive at the MCP boundary', async () => {
  const { handleListEvents } = await import('../dist/tools/event-memory-tools.js');
  globalThis.fetch = async () => {
    throw new Error('invalid mode must not reach API');
  };
  const mixed = await handleListEvents({ eventId: 'event-1', cat: 'opus' });
  const missingId = await handleListEvents({ charOffset: 0 });
  assert.equal(mixed.isError, true);
  assert.equal(missingId.isError, true);
});

test('F324: Event detail keeps foreign-owner 404 opaque through the MCP tool', async () => {
  const { handleListEvents } = await import('../dist/tools/event-memory-tools.js');
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ error: 'Event not found' }),
  });
  const result = await handleListEvents({ eventId: 'foreign', charOffset: 0 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /404/);
  assert.doesNotMatch(result.content[0].text, /summary|ownerUserId/);
});
