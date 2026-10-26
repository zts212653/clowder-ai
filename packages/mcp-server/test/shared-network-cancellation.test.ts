import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { sendCallbackRequest } from '../src/tools/callback-outbox.js';
import { callbackGet, callbackPost } from '../src/tools/callback-tools.js';
import { withInvocationCredentials } from '../src/tools/invocation-auth.js';

for (const method of ['GET', 'POST'] as const) {
  test(`cancelling an admitted ${method} stops its upstream request without retrying and preserves another caller`, async () => {
    let entered!: () => void;
    let closed!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const disconnected = new Promise<void>((done) => {
      closed = done;
    });
    let attempts = 0;
    const server = createServer((req, res) => {
      if (req.headers['x-invocation-id'] === 'fixture-A') {
        attempts++;
        res.once('close', closed);
        entered();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"owner":"B"}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();
    const pending = withInvocationCredentials(
      { invocationId: 'fixture-A', callbackToken: 'fixture-token-A', apiUrl, requestSignal: controller.signal },
      () =>
        method === 'GET'
          ? callbackGet('/fixture')
          : callbackPost('/fixture', {}, { retryDelaysMs: [10, 20], fetchTimeoutMs: 5000 }),
    );
    try {
      await started;
      controller.abort();
      const result = await Promise.race([pending, pause(1500).then(() => undefined)]);
      assert.ok(result?.isError, 'upstream cancellation must settle within the fixed two-second budget');
      assert.equal(await Promise.race([disconnected.then(() => true), pause(500).then(() => false)]), true);
      const other = await withInvocationCredentials(
        { invocationId: 'fixture-B', callbackToken: 'fixture-token-B', apiUrl },
        () => callbackGet('/fixture'),
      );
      assert.ok(JSON.stringify(other).includes('B'));
      assert.equal(attempts, 1, 'an explicit cancellation must not enqueue or retry an unknown write outcome');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await pending;
    }
  });
}

for (const cancelBeforeFlush of [false, true]) {
  test(`outbox survives cancellation ${cancelBeforeFlush ? 'before' : 'during'} a flush and recovers on a fresh call`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'f333-outbox-cancel-'));
    const savedEnv = { ...process.env };
    Object.assign(process.env, {
      CAT_CAFE_CALLBACK_OUTBOX_DIR: dir,
      CAT_CAFE_CALLBACK_OUTBOX_ENABLED: 'true',
      CAT_CAFE_CALLBACK_RETRY_DELAYS_MS: '0',
      CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS: '1',
    });
    t.after(async () => {
      process.env = savedEnv;
      await rm(dir, { recursive: true, force: true });
    });
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    let recovering = false;
    const posted: string[] = [];
    const server = createServer((req, res) => {
      posted.push(String(req.headers['x-invocation-id']));
      if (!recovering) {
        entered();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const original = ['queued-A', 'queued-B'].map((id, index) => ({
      name: `${index}-${id}.json`,
      raw: JSON.stringify({
        id,
        queuedAt: index,
        apiUrl,
        path: '/callback',
        body: { clientMessageId: id },
        headers: { 'x-invocation-id': id },
        attempts: 0,
        lastError: 'offline',
      }),
    }));
    for (const entry of original) await writeFile(join(dir, entry.name), entry.raw);
    const request = (id: string) => ({
      apiUrl,
      path: '/callback',
      body: { clientMessageId: id },
      headers: { 'x-invocation-id': id },
    });
    const controller = new AbortController();
    if (cancelBeforeFlush) controller.abort();
    const pending = withInvocationCredentials(
      { invocationId: 'cancelled-C', callbackToken: undefined, requestSignal: controller.signal },
      () => sendCallbackRequest(request('cancelled-C'), { enableOutbox: true, retryDelaysMs: [] }),
    );
    if (!cancelBeforeFlush) {
      await Promise.race([started, pause(1500).then(() => assert.fail('flush never sent the first entry'))]);
      controller.abort();
    }
    const result = await pending;
    assert.equal(result.ok, false, 'the cancelled new write must not be acknowledged or queued');
    assert.deepEqual(posted, cancelBeforeFlush ? [] : ['queued-A'], 'cancellation must stop the flush');
    assert.deepEqual(
      (await readdir(dir)).sort(),
      original.map((entry) => entry.name),
    );
    for (const entry of original) {
      assert.equal(
        await readFile(join(dir, entry.name), 'utf8'),
        entry.raw,
        'cancellation must not spend retry budget',
      );
    }
    recovering = true;
    posted.length = 0;
    const recovered = await withInvocationCredentials({ invocationId: 'fresh-D', callbackToken: undefined }, () =>
      sendCallbackRequest(request('fresh-D'), { enableOutbox: true, retryDelaysMs: [] }),
    );
    assert.equal(recovered.ok, true);
    assert.deepEqual(posted, ['queued-A', 'queued-B', 'fresh-D'], 'recovery keeps each original callback identity');
    assert.deepEqual(await readdir(dir), []);
  });
}
