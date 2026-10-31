import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';

let TranscriptWriter;
const roots = [];

const SESSION = {
  sessionId: 'session-f299',
  threadId: 'thread-f299',
  catId: 'codex-sol',
  seq: 0,
};

before(async () => {
  ({ TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js'));
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'f299-transcript-'));
  roots.push(root);
  return root;
}

function assembled(ordinal) {
  return {
    type: 'request_generation_assembled',
    envelope: {
      v: 1,
      invocationId: 'inv-f299',
      sessionId: SESSION.sessionId,
      generationOrdinal: ordinal,
      requestGenerationId: `generation-${ordinal}`,
    },
  };
}

describe('F299 durable request-generation transcript commit', () => {
  it('does not resolve until the event is durable and exposes it once through the active projection', async () => {
    const dataDir = await tempRoot();
    const writer = new TranscriptWriter({ dataDir });

    await writer.appendDurableEvent(SESSION, assembled(1), 'inv-f299');

    assert.equal(writer.getEventCount(SESSION.sessionId), 1);
    const livePath = join(
      dataDir,
      'threads',
      SESSION.threadId,
      SESSION.catId,
      'sessions',
      SESSION.sessionId,
      'events.live.jsonl',
    );
    const persisted = (await readFile(livePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].event.type, 'request_generation_assembled');

    const active = await writer.readActiveEvents(SESSION);
    assert.equal(active.length, 1);
    assert.equal(active[0].event.type, 'request_generation_assembled');
  });

  it('rejects a failed durable append and removes the uncommitted event from the readable buffer', async () => {
    const root = await tempRoot();
    const blockedDataDir = join(root, 'not-a-directory');
    await writeFile(blockedDataDir, 'occupied', 'utf8');
    const writer = new TranscriptWriter({ dataDir: blockedDataDir });

    await assert.rejects(writer.appendDurableEvent(SESSION, assembled(1), 'inv-f299'));
    assert.equal(writer.getEventCount(SESSION.sessionId), 0);
  });

  it('serializes ordinary and durable appends without duplicating either event after seal', async () => {
    const dataDir = await tempRoot();
    const writer = new TranscriptWriter({ dataDir });

    writer.appendEvent(SESSION, { type: 'status', content: 'before' }, 'inv-f299');
    await writer.appendDurableEvent(SESSION, assembled(1), 'inv-f299');
    writer.appendEvent(SESSION, { type: 'done' }, 'inv-f299');
    await writer.flush(SESSION);

    const sealedPath = join(
      dataDir,
      'threads',
      SESSION.threadId,
      SESSION.catId,
      'sessions',
      SESSION.sessionId,
      'events.jsonl',
    );
    const sealed = (await readFile(sealedPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      sealed.map((entry) => entry.event.type),
      ['status', 'request_generation_assembled', 'done'],
    );
  });

  it('keeps sensitive content digests stable across writer restarts without persisting a raw hash', async () => {
    const dataDir = await tempRoot();
    const first = new TranscriptWriter({ dataDir });
    const digest = await first.keyedContentDigest('low-entropy-secret');
    const restarted = new TranscriptWriter({ dataDir });

    assert.match(digest, /^hmac-sha256:[a-f0-9]{64}$/);
    assert.equal(await restarted.keyedContentDigest('low-entropy-secret'), digest);
    assert.notEqual(await restarted.keyedContentDigest('different'), digest);
  });
});
