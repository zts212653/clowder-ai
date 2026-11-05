import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mediaRangeFixture } from './collective-media-range.fixture.js';
import { CollectiveConnector, ConnectorTransportError, test } from './helpers/f202-collective-installed-business.js';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a pre-stop owner poll cannot admit jobs after the same owner object is reinstalled', async (t) => {
  const r = await mediaRangeFixture(t);
  const entered = gate(),
    release = gate();
  let held = false,
    validations = 0,
    reads = 0;
  const owner = await CollectiveConnector.open({
    dataDirectory: r.f.connectorDirectory,
    verifyAgent: async () => false,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/artifacts/constraints/validate') validations++;
      const response = await fetch(input, init);
      if (path === '/api/artifacts/media/poll' && !held) {
        const value = (await response.clone().json()) as { operations: unknown[] };
        if (value.operations.length) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      }
      return response;
    },
  });
  t.after(() => owner.stopMediaReads());
  const retained = r.f.media.port;
  const port = {
    execute: retained.execute.bind(retained),
    media: {
      read: async (...args: Parameters<typeof retained.media.read>) => {
        reads++;
        return retained.media.read(...args);
      },
    },
  };
  owner.setArtifactOwner(port);
  const controller = new AbortController();
  const pending = r.reader.openArtifactMedia(
    r.connection.connectionId,
    'reader-private-human',
    r.input,
    controller.signal,
  );
  // Observe any test-cleanup cancellation immediately while the old poll is intentionally held.
  void pending.catch(() => {});
  const syncing = (async () => {
    for (let tick = 0; tick < 100 && !held; tick++) {
      await owner.sync(r.f.connection.connectionId);
      if (!held) await setTimeout(5);
    }
  })();
  void syncing.catch(() => {});
  try {
    await bounded(entered.promise);
    await owner.stopMediaReads();
    owner.setArtifactOwner(port);
    release.resolve();
    await bounded(syncing);
    assert.equal(validations, 0, 'The old generation dispatched a fresh owner operation after stop');
    assert.equal(reads, 0);
    await owner.sync(r.f.connection.connectionId);
    const opened = await bounded(pending);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), r.f.media.bytes);
    assert.equal(reads, 1);
  } finally {
    release.resolve();
    controller.abort();
  }
});
async function bounded<T>(promise: Promise<T>) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      setTimeout(3000, undefined, { signal: controller.signal }).then(() => {
        throw new Error('Media admission did not settle');
      }),
    ]);
  } finally {
    controller.abort();
  }
}

for (const reopen of [false, true]) {
  test(`a read queued behind ordinary sync cannot revive after stop (reopen=${reopen})`, async (t) => {
    const r = await mediaRangeFixture(t);
    const entered = gate(),
      release = gate();
    let blocked = false,
      mediaRequests = 0;
    const reader = await CollectiveConnector.open({
      dataDirectory: r.directory,
      verifyAgent: async () => false,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/events/endpoint' && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        if (path === '/api/artifacts/media/read') mediaRequests++;
        return fetch(input, init);
      },
    });
    t.after(() => reader.stopMediaReads());
    const syncing = reader.sync(r.connection.connectionId);
    await bounded(entered.promise);
    const pending = reader
      .openArtifactMedia(r.connection.connectionId, 'reader-private-human', r.input, new AbortController().signal)
      .then(
        (opened) => ({ ok: true as const, opened }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await reader.stopMediaReads();
    if (reopen)
      reader.setArtifactOwner({ execute: async () => ({ status: 'error', error: { code: 'unsupported_operation' } }) });
    release.resolve();
    await bounded(syncing);
    const result = await bounded(r.drive(pending));
    if (result.ok) result.opened.body.destroy();
    assert.equal(result.ok, false, 'A pre-stop queued invocation acquired a new media stream after stop returned');
    if (result.ok) return;
    assert.ok(result.error instanceof ConnectorTransportError);
    assert.equal(result.error.statusCode, 503);
    assert.equal(mediaRequests, 0, 'A fenced admission must allocate no Service media request or slot');
    if (!reopen) {
      await assert.rejects(
        reader.openArtifactMedia(
          r.connection.connectionId,
          'reader-private-human',
          r.input,
          new AbortController().signal,
        ),
        (error) => error instanceof ConnectorTransportError && error.statusCode === 503,
      );
      assert.equal(mediaRequests, 0);
    }
    if (reopen) {
      const fresh = await r.drive(
        reader.openArtifactMedia(
          r.connection.connectionId,
          'reader-private-human',
          r.input,
          new AbortController().signal,
        ),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of fresh.body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), r.f.media.bytes);
      assert.equal(mediaRequests, 1);
    }
  });
}
