import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handleCapturePawFeel,
  handleListPawFeelInbox,
  handleTriagePawFeel,
  pawFeelDispositionTools,
} from '../dist/tools/paw-feel-disposition-tools.js';

describe('F278 MCP paw-feel tools', () => {
  const saved = {};
  let previousFetch;
  const requests = [];

  beforeEach(() => {
    for (const key of ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.CAT_CAFE_API_URL = 'http://localhost:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-1';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-1';
    previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    requests.length = 0;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('lists bounded inbox rows through callback auth filters', async () => {
    const result = await handleListPawFeelInbox({
      states: ['new', 'seen'],
      sourceCatId: 'codex-sol',
      overdueOnly: true,
      limit: 25,
      cursor: 'opaque',
      sort: 'newest',
    });

    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, '/api/callbacks/paw-feel-inbox');
    assert.equal(url.searchParams.get('states'), 'new,seen');
    assert.equal(url.searchParams.get('sourceCatId'), 'codex-sol');
    assert.equal(url.searchParams.get('overdueOnly'), 'true');
    assert.equal(url.searchParams.get('limit'), '25');
    assert.equal(url.searchParams.get('sort'), 'newest');
    assert.equal(requests[0].init.headers['x-invocation-id'], 'inv-1');
  });

  it('declares current-invocation capture before the final source message exists', async () => {
    const result = await handleCapturePawFeel({});

    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, '/api/callbacks/paw-feel-capture-intent');
    const body = JSON.parse(requests[0].init.body);
    assert.deepEqual(body, {});
    assert.equal(JSON.stringify(body).includes('sourceMessageId'), false);
    const tool = pawFeelDispositionTools.find((candidate) => candidate.name === 'cat_cafe_capture_paw_feel');
    assert.match(tool.description, /Agent-key sessions.*standalone source marker.*ambiguous/);
  });

  it('sends one common bundle action plus explicit exceptions without actor identity', async () => {
    const input = {
      bundleKey: 'turn:turn-1',
      membershipToken: 'signed-list-snapshot',
      eventIdPrefix: 'bundle-event-1',
      members: [
        { signalId: 'signal-1', expectedSequence: 1 },
        { signalId: 'signal-2', expectedSequence: 2 },
      ],
      action: { type: 'no_action', reasonCode: 'not_actionable' },
      exceptions: [
        {
          signalId: 'signal-2',
          action: { type: 'fix', leaseId: 'lease-active' },
        },
      ],
    };
    const result = await handleTriagePawFeel(input);

    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, '/api/callbacks/paw-feel-bundle-triage');
    const body = JSON.parse(requests[0].init.body);
    assert.deepEqual(body, input);
    assert.equal(JSON.stringify(body).includes('actor'), false);
    assert.equal(JSON.stringify(body).includes('targetThreadId'), false);
    const tool = pawFeelDispositionTools.find((candidate) => candidate.name === 'cat_cafe_triage_paw_feel');
    assert.equal(
      tool.inputSchema.action.safeParse({
        type: 'request_signature',
        action: { type: 'no_action', reasonCode: 'not_actionable' },
        preferredSignerCatId: 'opus5',
      }).success,
      true,
    );
    assert.equal(
      tool.inputSchema.action.safeParse({ type: 'block', blockerCode: 'external_wait', blockerRef: 'case:123' })
        .success,
      true,
    );
  });
});
