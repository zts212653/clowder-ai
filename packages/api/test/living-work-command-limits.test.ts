import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { MAX_HTML_WORK_COMMAND_BYTES, MAX_WORK_COMMAND_BYTES } from '@cat-cafe/shared';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

const entries = ['/api/works/command', '/api/callbacks/work'];
const transports = ['content-length', 'chunked'] as const;

function post(
  url: URL,
  headers: Record<string, string>,
  payload: Buffer,
  transport: (typeof transports)[number],
  leaveOpen = false,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          ...(transport === 'content-length'
            ? { 'content-length': String(payload.length) }
            : { 'transfer-encoding': 'chunked' }),
        },
        agent: false,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({ status: response.statusCode, body });
          request.destroy();
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('No response before request body ended')));
    // Fastify closes oversized Content-Length requests at the headers. Sending
    // their body concurrently races the 413 with a client-side EPIPE.
    if (transport === 'content-length' && payload.length > MAX_HTML_WORK_COMMAND_BYTES) {
      request.flushHeaders();
      return;
    }
    // Split a UTF-8 code point across chunks; subsequent chunks mix raw UTF-8
    // with JSON escapes. Neither character counts nor reserialization suffice.
    const split = Math.max(1, payload.indexOf(Buffer.from('猫')) + 1);
    request.write(payload.subarray(0, split));
    for (let offset = split; offset < payload.length; offset += 16_384) {
      request.write(payload.subarray(offset, offset + 16_384));
    }
    if (!leaveOpen) request.end();
  });
}

function pad(body: string, bytes: number) {
  return Buffer.from(body + ' '.repeat(bytes - Buffer.byteLength(body)));
}

for (const entry of entries) {
  for (const action of ['create', 'submit'] as const) {
    for (const transport of transports) {
      test(`${entry} ${action} enforces exact HTML wire bytes over ${transport}`, async (t) => {
        const f = await htmlFixture(t);
        const origin = await f.app.listen({ port: 0, host: '127.0.0.1' });
        const headers = entry === entries[0] ? { 'x-fixture-user': 'operator' } : f.headers;
        const first = action === 'submit' ? await f.service.commit(htmlCreate, f.principal) : null;
        const html = '猫x"\\\n'.repeat(2000);
        const command = {
          ...htmlCreate,
          action,
          operationId: 'wire-boundary',
          ...(first ? { contentRef: first.reference.contentRef, expectedOwnerRevision: 1 } : {}),
          source: { kind: 'html', html },
        };
        const body = JSON.stringify({ threadId: 'thread-cover', command }).replaceAll('x', '\\u0078');
        const boundary = pad(body, MAX_HTML_WORK_COMMAND_BYTES);
        assert.ok(boundary.toString().length < boundary.length);
        // Reject before saving, then accept exactly the limit. A rejection must
        // neither create a version nor consume the operation's idempotency key.
        const rejected = await post(
          new URL(entry, origin),
          headers,
          Buffer.concat([boundary, Buffer.from(' ')]),
          transport,
        );
        assert.equal(rejected.status, 413, rejected.body);
        const accepted = await post(new URL(entry, origin), headers, boundary, transport);
        assert.equal(accepted.status, 200, accepted.body);
        const result = JSON.parse(accepted.body);
        const reference = (entry === entries[0] ? result : JSON.parse(result.json)).reference;
        assert.equal(reference.ownerRevision, action === 'submit' ? 2 : 1);
        assert.equal((await f.service.readBody(reference, f.principal)).html, html);
      });
    }
  }

  for (const transport of transports) {
    test(`${entry} rejects invalid non-HTML inputs before full schema validation over ${transport}`, async (t) => {
      const f = await htmlFixture(t);
      const origin = await f.app.listen({ port: 0, host: '127.0.0.1' });
      const headers = entry === entries[0] ? { 'x-fixture-user': 'operator' } : f.headers;
      const payloads = [
        { threadId: 'thread-cover', command: { action: 'list' }, extra: '猫'.repeat(11_000) },
        { threadId: 'thread-cover', extra: '猫'.repeat(11_000) },
        { threadId: 'thread-cover', command: { action: 'unknown', value: '猫'.repeat(11_000) } },
        {
          threadId: 'thread-cover',
          command: { action: 'create', source: { kind: 'html' } },
          extra: '猫'.repeat(11_000),
        },
        { threadId: 'thread-cover', command: { action: 'set-context', context: { story: Array(7000).fill(null) } } },
        Array(7000).fill(null),
      ];
      for (const payload of payloads) {
        const body = Buffer.from(JSON.stringify(payload));
        assert.ok(body.length > MAX_WORK_COMMAND_BYTES);
        const response = await post(new URL(entry, origin), headers, body, transport);
        assert.equal(response.status, 413, response.body.slice(0, 512));
        assert.deepEqual(JSON.parse(response.body), { error: 'work_command_too_large' });
      }
      const invalid = JSON.stringify({ threadId: 'thread-cover', command: { action: 'unknown' } });
      assert.equal(
        (await post(new URL(entry, origin), headers, pad(invalid, MAX_WORK_COMMAND_BYTES), transport)).status,
        400,
      );
      assert.equal(
        (await post(new URL(entry, origin), headers, pad(invalid, MAX_WORK_COMMAND_BYTES + 1), transport)).status,
        413,
      );
      assert.equal(
        (await post(new URL(entry, origin), {}, pad(invalid, MAX_WORK_COMMAND_BYTES + 1), transport)).status,
        413,
      );
      assert.deepEqual((await f.service.list(f.principal)).items, []);
    });

    test(`${entry} rejects an oversized unfinished ${transport} body without waiting for EOF`, async (t) => {
      const f = await htmlFixture(t);
      const origin = await f.app.listen({ port: 0, host: '127.0.0.1' });
      // Fewer UTF-16 characters than the cap, but more raw bytes; no closing JSON
      // or HTTP end marker is sent, so an end-of-body check would time out.
      const payload = Buffer.from(
        `{"command":{"action":"create","source":{"kind":"html","html":"${'猫'.repeat(Math.ceil(MAX_HTML_WORK_COMMAND_BYTES / 3))}`,
      );
      assert.ok(payload.length > MAX_HTML_WORK_COMMAND_BYTES);
      assert.ok(payload.toString().length < MAX_HTML_WORK_COMMAND_BYTES);
      const response = await post(new URL(entry, origin), {}, payload, transport, true);
      assert.equal(response.status, 413, response.body);
    });
  }
}
