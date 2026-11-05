import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import {
  type CollectiveArtifactMediaOperation,
  type CollectiveMediaDescriptor,
  collectiveMediaDescriptorHeader,
  collectiveMediaRelaySlots,
} from '@cat-cafe/shared';
import { mediaRangeFixture } from './collective-media-range.fixture.js';
import { ConnectorTransportError, test } from './helpers/f202-collective-installed-business.js';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitGate(promise: Promise<void>, signal: AbortSignal) {
  if (signal.aborted) return;
  let abort = () => {};
  const canceled = new Promise<void>((resolve) => {
    abort = resolve;
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([promise, canceled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
async function bounded<T>(promise: Promise<T>, message: string) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      setTimeout(3000, undefined, { signal: controller.signal }).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

for (const cancel of ['caller', 'connector'] as const)
  test(`an active binary upload releases ordinary Cafe authority; ${cancel} cancellation closes the stream without a durable media copy`, async (t) => {
    const r = await mediaRangeFixture(t),
      { f } = r;
    const original = f.media.port,
      paused = gate(),
      closed = gate();
    f.connector.setArtifactOwner({
      execute: original.execute.bind(original),
      media: {
        async read(...args) {
          const result = await original.media.read(...args);
          if (result.status === 'error') return result;
          const body = Readable.from(
            (async function* () {
              try {
                for await (const chunk of result.body) {
                  assert.ok(Buffer.isBuffer(chunk));
                  yield chunk.subarray(0, 1);
                  await waitGate(paused.promise, args[2]);
                  if (args[2].aborted) return;
                  yield chunk.subarray(1);
                }
              } finally {
                result.body.destroy();
              }
            })(),
          );
          body.once('close', closed.resolve);
          return { ...result, body };
        },
      },
    });
    const controller = new AbortController();
    const opened = await r.drive(
      r.reader.openArtifactMedia(r.connection.connectionId, 'reader-private-human', r.input, controller.signal),
    );
    assert.equal(opened.body.readableEnded, false);
    await bounded(
      f.connector.sync(f.connection.connectionId),
      'The ordinary sync waited for an unfinished media stream',
    );
    if (cancel === 'caller') controller.abort();
    else {
      await r.reader.stopMediaReads();
      assert.equal(opened.body.closed, true, 'Connector stop returned before its admitted reader stream closed');
    }
    paused.resolve();
    await bounded(closed.promise, 'Reader cancellation left an owner stream running');
    await f.connector.stopMediaReads();
    assert.equal((await f.media.owner.listOutbox(f.media.asset.contentRef)).length, 1);
    for (const directory of [f.serviceDirectory, r.directory, f.connectorDirectory]) {
      for (const name of await readdir(directory, { recursive: true })) {
        if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
        const persisted = await readFile(join(directory, name));
        assert.equal(persisted.includes(f.media.bytes), false, name);
        for (const secret of ['thread-cover', 'task-cover', 'sourcePublication', '/uploads'])
          assert.equal(persisted.toString().includes(secret), false, `${name}: ${secret}`);
        if (directory !== f.connectorDirectory)
          assert.equal(persisted.toString().includes(f.credential), false, 'Foreign owner credential escaped');
      }
    }
  });

test('a revoke after owner admission but before disclosure denies the byte response while another Human remains authorized', async (t) => {
  const r = await mediaRangeFixture(t),
    { f } = r;
  const original = f.media.port,
    admitted = gate(),
    release = gate();
  f.connector.setArtifactOwner({
    execute: original.execute.bind(original),
    media: {
      async read(...args) {
        const result = await original.media.read(...args);
        admitted.resolve();
        await waitGate(release.promise, args[2]);
        return result;
      },
    },
  });
  const pending = r.read('bytes=0-31');
  // Attach rejection handling before changing authority, so the test cannot conceal an unhandled client error.
  const denied = assert.rejects(
    pending,
    (error) => error instanceof ConnectorTransportError && error.statusCode === 403,
  );
  await bounded(admitted.promise, 'Owner never admitted the read');
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-before-media-disclosure',
  });
  release.resolve();
  await denied;
  assert.equal((await f.invoke(f.owner.sessionToken, 'read', {}, 'other-Human-still-reads')).status, 200);
});

test('a duplicate owner response cannot cancel the already authorized active byte stream', async (t) => {
  const r = await mediaRangeFixture(t),
    { f } = r,
    original = f.media.port,
    paused = gate();
  let captured: { operation: CollectiveArtifactMediaOperation; descriptor: CollectiveMediaDescriptor } | undefined;
  f.connector.setArtifactOwner({
    execute: original.execute.bind(original),
    media: {
      async read(...args) {
        const result = await original.media.read(...args);
        if (result.status === 'error') return result;
        captured = { operation: args[0], descriptor: result.descriptor };
        const body = Readable.from(
          (async function* () {
            try {
              for await (const chunk of result.body) {
                assert.ok(Buffer.isBuffer(chunk));
                yield chunk.subarray(0, 1);
                await waitGate(paused.promise, args[2]);
                if (args[2].aborted) return;
                yield chunk.subarray(1);
              }
            } finally {
              result.body.destroy();
            }
          })(),
        );
        return { ...result, body };
      },
    },
  });
  const opened = await r.drive(
    r.reader.openArtifactMedia(
      r.connection.connectionId,
      'reader-private-human',
      r.input,
      new AbortController().signal,
    ),
  );
  assert.ok(captured);
  const query = new URLSearchParams({
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    relayRef: captured.operation.relayRef,
  });
  try {
    const duplicate = await fetch(`${f.server.url}/api/artifacts/media/respond?${query}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.credential}`,
        'content-length': '0',
        [collectiveMediaDescriptorHeader]: encodeURIComponent(JSON.stringify(captured.descriptor)),
      },
    });
    assert.equal(duplicate.status, 409);
    await duplicate.body?.cancel();
  } finally {
    paused.resolve();
  }
  const bytes: Buffer[] = [];
  for await (const chunk of opened.body) {
    assert.ok(Buffer.isBuffer(chunk));
    bytes.push(chunk);
  }
  assert.deepEqual(Buffer.concat(bytes), f.media.bytes);
});

test('owner shutdown during a fresh read closes an unconsumed source without crashing the Connector', async (t) => {
  const r = await mediaRangeFixture(t),
    { f } = r,
    original = f.media.port,
    prepared = gate();
  f.connector.setArtifactOwner({
    execute: original.execute.bind(original),
    media: {
      async read(...args) {
        const result = await original.media.read(...args);
        prepared.resolve();
        await waitGate(new Promise<void>(() => {}), args[2]);
        return result;
      },
    },
  });
  const pending = r.read('bytes=0-31');
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof ConnectorTransportError && error.statusCode === 503,
  );
  await bounded(prepared.promise, 'The owner never opened its source');
  f.connector.setArtifactOwner(undefined);
  await f.connector.stopMediaReads();
  f.store.stopArtifactOwnerRelay();
  await rejected;
});

test('media requests have a global transient budget and abort releases its slots; a disconnected owner reports unavailable', async (t) => {
  const r = await mediaRangeFixture(t),
    { f } = r;
  const controllers = Array.from({ length: collectiveMediaRelaySlots + 1 }, () => new AbortController());
  const attempts = controllers.map((controller) =>
    fetch(`${f.server.url}/api/artifacts/media/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${r.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...r.coordinates, ...r.input }),
      signal: controller.signal,
    }),
  );
  const overflow = Promise.any(
    attempts.map(async (request) => {
      const response = await request;
      assert.equal(response.status, 429);
      return response.json();
    }),
  );
  const result = await bounded(overflow, 'Media budget did not reject an extra unserved stream');
  assert.equal(result.error.code, 'ARTIFACT_BUSY');
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(attempts);
  for (let tick = 0; tick < 100; tick++) {
    const polled = await f.post('media/poll', f.credential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
    });
    if (polled.value.operations.length === 0) break;
    await setTimeout(5);
  }
  assert.deepEqual((await r.read('bytes=0-31')).bytes, f.media.bytes.subarray(0, 32));
  await f.store.revokeConnection({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    connectionId: f.connection.connectionId,
  });
  await assert.rejects(
    r.read('bytes=32-63'),
    (error) =>
      error instanceof ConnectorTransportError &&
      error.statusCode === 503 &&
      error.causeCode === 'ARTIFACT_OWNER_UNAVAILABLE',
  );
});
