/**
 * F257 #3 (2a R1 P2-1) — cat_cafe_list_objectives handler tests.
 *
 * Focused formatting + failure-path coverage. Mocks globalThis.fetch since the
 * handler calls the API discovery route internally. Proves: success formatting
 * (id — statement, no segments), honest empty, and that transport/HTTP failures
 * surface as errorResult (isError) rather than a misleading empty catalog.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

let handleListObjectives;
let originalFetch;

before(async () => {
  ({ handleListObjectives } = await import('../dist/tools/list-objectives-tool.js'));
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('F257 #3 — handleListObjectives', () => {
  test('formats registered objectives (id — statement, no segments)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        registryVersion: 1,
        objectives: [
          { id: 'obj-routing-delivery', statement: '球权路由准确送达' },
          { id: 'obj-identity-integrity', statement: '签名/身份正确' },
        ],
      }),
    });
    const res = await handleListObjectives();
    assert.notEqual(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /obj-routing-delivery — 球权路由准确送达/);
    assert.match(text, /obj-identity-integrity — 签名\/身份正确/);
    assert.doesNotMatch(text, /segments/i, 'no segments authority leaks into output');
    assert.match(text, /do not invent/i, 'guides cats to pick, not invent');
  });

  test('honest empty for a valid-but-empty catalog', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ registryVersion: 1, objectives: [] }) });
    const res = await handleListObjectives();
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /No objectives registered yet/);
  });

  test('HTTP failure (503 fail-closed) surfaces as errorResult, not empty success', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Objective registry unavailable: registry unreadable',
    });
    const res = await handleListObjectives();
    assert.equal(res.isError, true, 'failure must be an error result');
    assert.match(res.content[0].text, /503/);
    assert.match(res.content[0].text, /unavailable/i);
  });

  test('network error surfaces as errorResult', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const res = await handleListObjectives();
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ECONNREFUSED/);
  });
});
