import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_HTML_WORK_BYTES, MAX_WORK_COMMAND_BYTES, workCommandSchema } from '@cat-cafe/shared';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

const entries = ['/api/works/command', '/api/callbacks/work'];
const reviewResponse = {
  reviewId: 'review-probe',
  sourceRound: 1,
  expectedReviewRevision: 1,
  expectedTaskRevision: 1,
  responses: Array(7000).fill(null),
};

for (const url of entries) {
  for (const action of ['create', 'submit'] as const) {
    test(`${url} ${action} rejects HTML metadata before expanding schemas or authenticating callbacks`, async (t) => {
      const f = await htmlFixture(t);
      const parse = t.mock.method(workCommandSchema, '_parse');
      const verify = t.mock.method(f.registry, 'verify');
      const commit = t.mock.method(f.service, 'commit');
      const command = {
        ...htmlCreate,
        action,
        ...(action === 'submit' ? { contentRef: 'work:missing', expectedOwnerRevision: 1 } : {}),
      };
      const body = { threadId: 'thread-cover', command };
      const cases = [
        {
          name: 'forbidden reviewResponse',
          payload: { ...body, command: { ...command, reviewResponse } },
          status: 400,
        },
        {
          name: 'small forbidden reviewResponse',
          payload: { ...body, command: { ...command, reviewResponse: {} } },
          status: 400,
        },
        {
          name: 'near hard-cap forbidden reviewResponse',
          payload: {
            ...body,
            command: { ...command, reviewResponse: { ...reviewResponse, responses: Array(300_000).fill(null) } },
          },
          status: 400,
        },
        {
          name: 'other array field',
          payload: { ...body, command: { ...command, title: Array(7000).fill(null) } },
          status: 400,
        },
        { name: 'nested extra field', payload: { ...body, extra: { story: Array(7000).fill(null) } }, status: 400 },
        {
          name: 'source extra array',
          payload: { ...body, command: { ...command, source: { ...command.source, extra: Array(7000).fill(null) } } },
          status: 400,
        },
        {
          name: 'large metadata string',
          payload: { ...body, command: { ...command, changeSummary: '猫'.repeat(11_000) } },
          status: 413,
        },
        { name: 'large envelope extra', payload: { ...body, extra: 'x'.repeat(MAX_WORK_COMMAND_BYTES) }, status: 413 },
        { name: 'large key', payload: { ...body, ['x'.repeat(MAX_WORK_COMMAND_BYTES)]: '' }, status: 413 },
        { name: 'HTML outside body slot', payload: { ...body, html: 'x'.repeat(MAX_WORK_COMMAND_BYTES) }, status: 413 },
        {
          name: 'large action discriminator',
          payload: { ...body, command: { ...command, action: 'x'.repeat(MAX_WORK_COMMAND_BYTES) } },
          status: 413,
        },
        {
          name: 'large source discriminator',
          payload: {
            ...body,
            command: { ...command, source: { ...command.source, kind: 'x'.repeat(MAX_WORK_COMMAND_BYTES) } },
          },
          status: 413,
        },
        {
          name: 'many small extra fields',
          payload: { ...body, ...Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, null])) },
          status: 413,
        },
        {
          name: 'escaped metadata',
          payload: { ...body, command: { ...command, changeSummary: '\u0001'.repeat(6000) } },
          status: 413,
        },
      ];
      for (const item of cases) {
        const started = performance.now();
        const response = await f.app.inject({
          method: 'POST',
          url,
          headers: url === entries[0] ? { 'x-fixture-user': 'operator' } : f.headers,
          payload: item.payload,
        });
        t.diagnostic(
          `${item.name}: ${Buffer.byteLength(response.body)} response bytes, ${(performance.now() - started).toFixed(2)} ms`,
        );
        assert.equal(response.statusCode, item.status, `${item.name}: ${response.body.slice(0, 200)}`);
        assert.deepEqual(response.json(), {
          error: item.status === 413 ? 'work_command_too_large' : 'invalid_request',
        });
        assert.equal(parse.mock.callCount(), 0, `${item.name}: full schema must not run`);
        assert.equal(verify.mock.callCount(), 0, `${item.name}: callback auth must not run`);
        assert.equal(commit.mock.callCount(), 0, `${item.name}: commit must not run`);
      }
      assert.deepEqual((await f.service.list(f.principal)).items, []);
    });

    test(`${url} ${action} still saves and reads exactly 1 MiB of HTML`, async (t) => {
      const f = await htmlFixture(t);
      const first = action === 'submit' ? await f.service.commit(htmlCreate, f.principal) : null;
      const html = '猫'.repeat(Math.floor(MAX_HTML_WORK_BYTES / 3)) + 'x'.repeat(MAX_HTML_WORK_BYTES % 3);
      const command = {
        ...htmlCreate,
        action,
        operationId: 'body-budget-boundary',
        ...(first ? { contentRef: first.reference.contentRef, expectedOwnerRevision: 1 } : {}),
        source: { kind: 'html', html },
      };
      const response = await f.app.inject({
        method: 'POST',
        url,
        headers: url === entries[0] ? { 'x-fixture-user': 'operator' } : f.headers,
        payload: { threadId: 'thread-cover', command },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = url === entries[0] ? response.json() : JSON.parse(response.json().json);
      assert.equal(result.reference.ownerRevision, first ? 2 : 1);
      assert.equal((await f.service.readBody(result.reference, f.principal)).html, html);
    });
  }

  test(`${url} exempts only the HTML value from the exact metadata JSON budget`, async (t) => {
    const f = await htmlFixture(t);
    const parse = t.mock.method(workCommandSchema, '_parse');
    const metadata = {
      threadId: 'thread-cover',
      command: { ...htmlCreate, source: { kind: 'html', html: '' } },
      extra: '',
    };
    const remaining = MAX_WORK_COMMAND_BYTES - Buffer.byteLength(JSON.stringify(metadata));
    const payload = { ...metadata, command: htmlCreate, extra: 'x'.repeat(remaining) };
    const options = {
      method: 'POST' as const,
      url,
      headers: url === entries[0] ? { 'x-fixture-user': 'operator' } : f.headers,
    };
    const boundary = await f.app.inject({ ...options, payload });
    assert.equal(boundary.statusCode, 400, 'budget passes; strict envelope rejects the extra field');
    assert.ok(parse.mock.callCount() > 0, 'exact budget reaches full schema');
    const calls = parse.mock.callCount();
    const over = await f.app.inject({ ...options, payload: { ...payload, extra: `${payload.extra}x` } });
    assert.equal(over.statusCode, 413);
    assert.deepEqual(over.json(), { error: 'work_command_too_large' });
    assert.equal(parse.mock.callCount(), calls, 'one byte over budget never reaches full schema');
  });

  test(`${url} bounds every Work Zod error response including nested union errors and unknown keys`, async (t) => {
    const f = await htmlFixture(t);
    const cases = [
      { threadId: 'thread-cover', command: { action: 'set-context', context: { story: Array(4000).fill(null) } } },
      { threadId: 'thread-cover', command: { ...htmlCreate, title: 42 } },
      { threadId: 'thread-cover', command: { ...htmlCreate, source: { kind: 'html', html: '\u0000' } } },
      {
        threadId: 'thread-cover',
        command: { ...htmlCreate, ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, 0])) },
      },
    ];
    for (const payload of cases) {
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= MAX_WORK_COMMAND_BYTES);
      const response = await f.app.inject({
        method: 'POST',
        url,
        headers: url === entries[0] ? { 'x-fixture-user': 'operator' } : f.headers,
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: 'invalid_request' });
      assert.equal(Buffer.byteLength(response.body), 27, 'fixed response budget, no issues serialized');
    }
  });
}
