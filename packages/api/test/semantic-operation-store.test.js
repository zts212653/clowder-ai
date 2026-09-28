import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SemanticOperationReuseError,
  SemanticOperationStore,
} from '../dist/domains/collaborative-content/semantic-operation-store.js';

test('concurrent and restarted semantic requests retain one timestamp and reject changed intent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f309-semantic-intent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    contentRef: 'docx:shared',
    actor: { kind: 'cat', actorId: 'codex-astra' },
    operationId: 'same-op',
    expectedOwnerRevision: 1,
    operation: {
      kind: 'comment',
      target: { paragraphId: 'p:1:anchor', textQuote: 'PRIVATE DOCUMENT TEXT' },
      body: 'PRIVATE COMMENT',
    },
  };
  const stores = Array.from(
    { length: 8 },
    (_, index) => new SemanticOperationStore(directory, () => `2026-09-06T00:00:0${index}.000Z`),
  );
  const results = await Promise.all(stores.map((store) => store.prepare(input)));
  assert.ok(results.every((row) => JSON.stringify(row) === JSON.stringify(results[0])));
  assert.deepEqual(await new SemanticOperationStore(directory).prepare(input), results[0]);
  await assert.rejects(
    stores[0].prepare({ ...input, operation: { ...input.operation, body: 'changed' } }),
    SemanticOperationReuseError,
  );
  await assert.rejects(stores[0].prepare({ ...input, expectedOwnerRevision: 2 }), SemanticOperationReuseError);
  const otherActor = await stores[0].prepare({ ...input, actor: { kind: 'cat', actorId: 'codex-sol' } });
  assert.notEqual(otherActor.operationId, results[0].operationId);
  const files = await readdir(join(directory, 'projects/collaborative-content-v1/semantic-intents'));
  assert.equal(files.length, 2);
  for (const file of files) {
    const persisted = await readFile(
      join(directory, 'projects/collaborative-content-v1/semantic-intents', file),
      'utf8',
    );
    assert.doesNotMatch(persisted, /PRIVATE|receipt|ownerRevision|sessionToken/);
  }
});
