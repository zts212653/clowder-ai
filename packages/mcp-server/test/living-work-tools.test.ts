import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { handleWorkCommand, workCommandInputSchema } from '../src/tools/work-tools.js';

test('a slow accepted Work submission returns its receipt without automatic HTTP resubmission', async (t) => {
  const previous = { ...process.env };
  let requests = 0;
  let uncertain = false;
  const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 2 };
  const server = createServer((_request, response) => {
    requests++;
    if (uncertain) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'submission_outcome_unknown' }));
      return;
    }
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          encoding: 'json-text-chunk',
          snapshot: `sha256:${'b'.repeat(64)}`,
          json: JSON.stringify({ status: 'saved', reference }),
          nextCursor: null,
        }),
      );
    }, 250);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.CAT_CAFE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.CAT_CAFE_INVOCATION_ID = 'slow-work-producer';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-callback';
  process.env.CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS = '75';
  process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '1';
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  const result = await handleWorkCommand({
    cursor: 0,
    command: {
      action: 'submit',
      operationId: 'one-accepted-intent',
      contentRef: reference.contentRef,
      expectedOwnerRevision: 1,
      title: 'Film',
      changeSummary: 'Second cut',
      source: { worktreeId: 'registered-root', path: 'v2.mp4', expectedSourceRevision: `sha256:${'c'.repeat(64)}` },
    },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(JSON.parse(JSON.parse(result.content[0]?.text ?? '').json).reference, reference);
  assert.equal(requests, 1, 'an accepted slow file operation must not be repeatedly submitted');
  uncertain = true;
  const unknown = await handleWorkCommand({
    cursor: 0,
    command: { action: 'inspect-source', locator: { worktreeId: 'registered-root', path: 'v3.mp4' } },
  });
  assert.equal(unknown.isError, true);
  assert.equal(requests, 2, 'an unknown file result is surfaced without automatically repeating the request');
});

test('explicit delivery attaches the exact owner card; reads stay silent and failed attachment is not reported delivered', async (t) => {
  const previous = { ...process.env },
    fetcher = globalThis.fetch;
  const outbox = await mkdtemp(join(tmpdir(), 'f326-reference-outbox-'));
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'current-production';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-callback';
  process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outbox;
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    globalThis.fetch = fetcher;
    await rm(outbox, { recursive: true, force: true });
  });
  const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
  const block = {
    id: 'work-reference-exact',
    v: 1,
    kind: 'card',
    title: '第一版',
    bodyMarkdown: '首次交付',
    meta: { kind: 'work_reference', reference },
  };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let permitted = true,
    attached = true,
    chunked = false,
    drift = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/work')) {
      const cursor = Number(body.cursor ?? 0),
        json = JSON.stringify({ reference, block });
      const end = chunked ? Math.min(json.length, cursor + 120) : json.length;
      return new Response(
        JSON.stringify(
          permitted
            ? {
                encoding: 'json-text-chunk',
                snapshot: `sha256:${(drift && cursor ? 'c' : 'b').repeat(64)}`,
                json: json.slice(cursor, end),
                nextCursor: end < json.length ? end : null,
              }
            : { error: 'access_denied' },
        ),
        { status: permitted ? 200 : 403, headers: { 'content-type': 'application/json' } },
      );
    }
    assert.ok(String(url).endsWith('/create-rich-block'));
    return new Response(JSON.stringify({ status: attached ? 'ok' : 'queued' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const input = { command: { action: 'publish-reference' as const, reference }, cursor: 0 };
  const result = await handleWorkCommand(input);
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.body.block, block);
  assert.equal(JSON.parse(result.content[0]?.text ?? '').status, 'reference_attached');
  calls.length = 0;
  await handleWorkCommand({ command: { action: 'read', reference }, cursor: 0 });
  assert.equal(calls.length, 1);
  calls.length = 0;
  const delegated = z
    .object(workCommandInputSchema)
    .strict()
    .parse({
      command: { action: 'read', reference },
      cursor: 0,
      contentTaskId: 'original-publication-task',
    });
  await handleWorkCommand(delegated);
  assert.equal(calls[0]?.body.contentTaskId, 'original-publication-task');
  calls.length = 0;
  permitted = false;
  assert.equal((await handleWorkCommand(input)).isError, true);
  assert.equal(calls.length, 1);
  permitted = true;
  attached = false;
  assert.equal((await handleWorkCommand(input)).isError, true);
  calls.length = 0;
  attached = true;
  chunked = true;
  block.bodyMarkdown = '片子改了什么："范围"\n'.repeat(100);
  assert.equal((await handleWorkCommand(input)).isError, undefined);
  assert.ok(calls.length > 2);
  assert.deepEqual(calls.at(-1)?.body.block, block);
  calls.length = 0;
  drift = true;
  assert.equal((await handleWorkCommand(input)).isError, true);
  assert.ok(
    calls.every((call) => call.url.endsWith('/work')),
    'snapshot drift never attaches a mixed card',
  );
  assert.equal(reference.ownerRevision, 1);
});
