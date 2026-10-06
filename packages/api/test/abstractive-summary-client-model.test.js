import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const { createAbstractiveClient } = await import('../dist/domains/memory/AbstractiveSummaryClient.js');

const profile = { mode: 'api_key', baseUrl: 'https://relay.example', apiKey: 'sk-test' };
const logger = { info() {}, error() {} };
const input = {
  threadId: 't1',
  previousSummary: null,
  messages: [{ id: 'm1', content: 'hello', timestamp: 1 }],
};
const REPLY = '# Title\n\nA summary paragraph long enough to parse as a single segment of the thread.';

function stubFetch() {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: REPLY }] }), { status: 200 });
  });
  return calls;
}

describe('createAbstractiveClient F102_MODEL', () => {
  let saved;
  beforeEach(() => {
    saved = process.env.F102_MODEL;
    delete process.env.F102_MODEL;
  });
  afterEach(() => {
    mock.restoreAll();
    if (saved === undefined) delete process.env.F102_MODEL;
    else process.env.F102_MODEL = saved;
  });

  it('defaults to claude-opus-4-6 and reports it on the result', async () => {
    const calls = stubFetch();
    const result = await createAbstractiveClient(async () => profile, logger)(input);
    assert.equal(calls[0].url, 'https://relay.example/v1/messages');
    assert.equal(calls[0].body.model, 'claude-opus-4-6');
    assert.equal(result.model, 'claude-opus-4-6');
  });

  it('uses F102_MODEL for the request and the result', async () => {
    process.env.F102_MODEL = 'claude-opus-5-5';
    const calls = stubFetch();
    const result = await createAbstractiveClient(async () => profile, logger)(input);
    assert.equal(calls[0].body.model, 'claude-opus-5-5');
    assert.equal(result.model, 'claude-opus-5-5');
  });

  it('falls back to the default for a whitespace-only F102_MODEL', async () => {
    process.env.F102_MODEL = '   ';
    const calls = stubFetch();
    const result = await createAbstractiveClient(async () => profile, logger)(input);
    assert.equal(calls[0].body.model, 'claude-opus-4-6');
    assert.equal(result.model, 'claude-opus-4-6');
  });

  it('reads F102_MODEL per invocation, not at factory creation', async () => {
    const calls = stubFetch();
    const client = createAbstractiveClient(async () => profile, logger);
    await client(input);
    process.env.F102_MODEL = 'claude-opus-5-5';
    await client(input);
    assert.deepEqual(
      calls.map((c) => c.body.model),
      ['claude-opus-4-6', 'claude-opus-5-5'],
    );
  });
});
