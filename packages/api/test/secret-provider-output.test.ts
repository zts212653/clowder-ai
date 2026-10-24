import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Shared native/MCP boundary is an ESM script.
import { protectSecretToolResult } from '../../../scripts/lib/secret-tool-io.mjs';
import { protectNativeProviderResult } from '../src/domains/cats/services/agents/invocation/secret-provider-result.js';
import { sanitizeRawEvent } from '../src/domains/cats/services/agents/providers/codex-audit-hooks.js';

const fake = () => ['ghp', '_', 'Q'.repeat(36)].join('');
test('raw archive sanitization hides credential-shaped text at native result depth', () => {
  const event = {
    type: 'tool_result',
    message: { content: [{ type: 'text', text: fake(), nested: { callbackToken: 'fixture-opaque' } }] },
  };
  const safe = JSON.stringify(sanitizeRawEvent(event));
  assert.ok(!safe.includes(fake()));
  assert.ok(!safe.includes('fixture-opaque'));
});

test('provider result boundary records a credential-free warning with the exact invocation auth', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ body: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push({ body: String(init?.body), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ messageId: 'notice-fixture' }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await protectNativeProviderResult(
      { type: 'tool_result', catId: 'gemini-argon', toolUseId: 'native-result-fixture', content: fake(), timestamp: 0 },
      {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
          CAT_CAFE_INVOCATION_ID: 'fixture-inv',
          CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback',
        },
      },
    );
    assert.ok(!JSON.stringify(result).includes(fake()));
    assert.match(result.content ?? '', /轮转/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers['x-invocation-id'], 'fixture-inv');
    assert.equal(requests[0].headers['x-callback-token'], 'fixture-callback');
    assert.ok(!requests[0].body.includes(fake()));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blocked native input echoed in ACP metadata is redacted without inventing result exposure', async () => {
  const originalFetch = globalThis.fetch;
  let notices = 0;
  globalThis.fetch = (async () => {
    notices++;
    return new Response('{"messageId":"unexpected-notice"}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await protectNativeProviderResult(
      {
        type: 'tool_result',
        catId: 'kimi',
        timestamp: 0,
        toolUseId: 'blocked-call',
        toolName: `Publish ${fake()}`,
        toolInput: { command: fake() },
        toolRawPayload: { rawInput: { command: fake() }, rawOutput: 'secret_content_blocked_before_send' },
        content: 'secret_content_blocked_before_send',
        toolResultStatus: 'error',
      },
      {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
          CAT_CAFE_INVOCATION_ID: 'current',
          CAT_CAFE_CALLBACK_TOKEN: 'fixture',
        },
      },
    );
    assert.ok(!JSON.stringify(result).includes(fake()));
    assert.equal(notices, 0);
    assert.doesNotMatch(result.content ?? '', /轮转/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an uninspectable native payload is discarded instead of retaining unsafe raw fields', async () => {
  let nested: unknown = fake();
  for (let depth = 0; depth < 66; depth++) nested = { nested };
  const result = await protectNativeProviderResult(
    {
      type: 'tool_result',
      catId: 'kimi',
      timestamp: 0,
      toolInput: { value: fake() },
      toolRawPayload: { rawOutput: nested },
      content: 'Oversized result',
    },
    {},
  );
  assert.ok(!JSON.stringify(result).includes(fake()));
  assert.equal(result.toolRawPayload, undefined);
  assert.equal(result.toolInput, undefined);
  assert.match(result.content ?? '', /hidden|轮转/);
});

test('raw native output still counts as exposure when the display content omits it', async () => {
  const result = await protectNativeProviderResult(
    {
      type: 'tool_result',
      catId: 'kimi',
      timestamp: 0,
      content: 'Display summary',
      toolRawPayload: { rawOutput: { value: fake() } },
    },
    {},
  );
  assert.ok(!JSON.stringify(result).includes(fake()));
  assert.match(result.content ?? '', /轮转/);
});

test('pooled native result persists a relay warning with current turn auth when the child has none', async () => {
  const safe = await protectSecretToolResult({ content: [{ type: 'text', text: fake() }] });
  const originalFetch = globalThis.fetch;
  let notices = 0;
  globalThis.fetch = (async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>)['x-invocation-id'], 'current-turn');
    notices++;
    return new Response('{"messageId":"pooled-notice"}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await protectNativeProviderResult(
      {
        type: 'tool_result',
        catId: 'kimi',
        toolUseId: 'native-relay-call',
        timestamp: 0,
        content: safe.content.map((part: { text: string }) => part.text).join('\n'),
      },
      {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
          CAT_CAFE_INVOCATION_ID: 'current-turn',
          CAT_CAFE_CALLBACK_TOKEN: 'current-fixture',
        },
      },
    );
    assert.equal(notices, 1);
    assert.ok(!JSON.stringify(result).includes(fake()));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
