import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { evalLifecycleTools, handleRecordEvalLifecycle } from '../dist/tools/eval-lifecycle-tools.js';

describe('F266 MCP stable-case lifecycle writeback', () => {
  const saved = {};
  let previousFetch;
  const requests = [];

  beforeEach(() => {
    for (const key of ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.CAT_CAFE_API_URL = 'http://localhost:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-owner';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-owner';
    previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ outcome: 'appended' }), {
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

  it('routes an owner fact without caller-authored identity or SLA', async () => {
    const result = await handleRecordEvalLifecycle({
      verdictId: 'capability-wakeup-2026-08-01-rich-messaging',
      eventId: 'f266-main-landed',
      expectedSequence: 3,
      reason: 'reviewed implementation landed',
      refs: [{ kind: 'pull_request', availability: 'available', value: 'https://github.com/example/pr/1' }],
      action: { type: 'record_main_landed', commitSha: 'a'.repeat(40) },
    });

    assert.equal(result.isError, undefined);
    assert.equal(
      new URL(requests[0].url).pathname,
      '/api/eval-verdicts/capability-wakeup-2026-08-01-rich-messaging/lifecycle-events',
    );
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.type, 'record_main_landed');
    assert.equal(body.commitSha, 'a'.repeat(40));
    assert.equal(JSON.stringify(body).includes('actor'), false);
    assert.equal(JSON.stringify(body).includes('dueAt'), false);
    assert.equal(requests[0].init.headers['x-invocation-id'], 'inv-owner');
  });

  it('describes the task/lease, operator, and server-truth boundaries', () => {
    const tool = evalLifecycleTools[0];
    assert.match(tool.description, /durable task\/F167 lease/);
    assert.match(tool.description, /suppressing on behalf of operator/);
    assert.match(tool.description, /main and live are separate server-verified facts/);
  });
});
