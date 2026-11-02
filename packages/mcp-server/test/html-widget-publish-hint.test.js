/**
 * #1640: create_rich_block tells the authoring cat when an html_widget carries
 * inline on* attributes the widget sanitizer will strip.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const HANDLER_CODE = 'secretHandlerBody()';
const widget = (html) => JSON.stringify({ id: 'w1', kind: 'html_widget', v: 1, html });

describe('create_rich_block html_widget inline handler hint', () => {
  let originalEnv;
  let originalFetch;
  let outboxDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    outboxDir = join(tmpdir(), `cat-cafe-mcp-outbox-widget-hint-${Date.now()}-${Math.random()}`);
    mkdirSync(outboxDir, { recursive: true });
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outboxDir;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    if (outboxDir && existsSync(outboxDir)) rmSync(outboxDir, { recursive: true, force: true });
  });

  test('Route A success names the attributes and points to addEventListener without echoing handler code', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');
    let postedHtml;
    globalThis.fetch = async (_url, options) => {
      postedHtml = JSON.parse(options.body).block.html;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const html = `<button onclick="${HANDLER_CODE}" onMouseOver='${HANDLER_CODE}'>go</button>`;
    const result = await handleCreateRichBlock({ block: widget(html) });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.startsWith('{"status":"ok"}'), 'original callback result stays first');
    assert.match(text, /onclick, onmouseover/);
    assert.match(text, /addEventListener/);
    assert.ok(!text.includes(HANDLER_CODE), 'handler code must not be echoed');
    assert.equal(postedHtml, html, 'publication payload is unchanged');
  });

  test('Route B fallback success carries the same hint', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');
    globalThis.fetch = async (url) => {
      if (url.includes('create-rich-block')) {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: 'callback_auth_failed', reason: 'unknown_invocation' }),
        };
      }
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const result = await handleCreateRichBlock({ block: widget('<div onclick="x()">hi</div>') });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /B_fallback/);
    assert.match(result.content[0].text, /INLINE EVENT HANDLERS: detected inline event attribute\(s\) onclick\./);
  });

  test('addEventListener widgets and non-widget blocks get no hint', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');
    const clean = widget(
      `<button id="b">go</button><script>document.getElementById('b').addEventListener('click', () => {}); const s = '<b onclick="x">';</script>`,
    );
    const card = JSON.stringify({ id: 'c1', kind: 'card', v: 1, title: 'onclick="x()"' });

    for (const block of [clean, card]) {
      const result = await handleCreateRichBlock({ block });
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, '{"status":"ok"}');
    }
  });

  test('failed publication returns the error without a hint', async () => {
    const { handleCreateRichBlock } = await import('../dist/tools/callback-tools.js');
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'bad_request' }),
    });

    const result = await handleCreateRichBlock({ block: widget('<button onclick="x()">go</button>') });

    assert.equal(result.isError, true);
    assert.ok(!result.content[0].text.includes('INLINE EVENT HANDLERS'));
  });
});
