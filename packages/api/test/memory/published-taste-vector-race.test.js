import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { PublishedDocumentIndex } from '../../dist/domains/memory/PublishedDocumentIndex.js';
import { PublishedDocumentSource } from '../../dist/domains/memory/PublishedDocumentSource.js';
import { ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { tasteDocumentAnchor, tasteMemoryId } from '../../dist/domains/memory/taste/taste-memory-identity.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';
import { fixture, original, owner, revision, sourcePath } from '../helpers/published-taste-fixture.js';

test('published Taste embeds after its fence and cannot revive a vector when forgotten during embedding', async () => {
  const f = await fixture();
  const projection = new PublishedDocumentIndex(
    new PublishedDocumentSource(f.primary, {
      ownerUserId: owner,
      lifecycle: f.store,
    }),
    f.evidence,
  );
  const builder = new IndexBuilder(
    f.evidence,
    join(f.primary, 'docs'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    projection,
  );
  const anchor = tasteDocumentAnchor(sourcePath);
  const db = f.evidence.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  const vectorStore = new VectorStore(db, 4);
  let forgetDuringEmbed = false;
  let forgotten = false;
  const embedding = {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    load: async () => {},
    dispose: () => {},
    getModelInfo: () => ({ modelId: 'test-model', modelRev: 'v1', dim: 4 }),
    embed: async (texts) => {
      if (forgetDuringEmbed && !forgotten) {
        forgotten = true;
        const result = await f.service.executeOwnerAction(owner, tasteMemoryId(sourcePath), sourcePath, {
          action: 'hard_forget',
          requestId: 'f332-forget-during-embed',
          expectedRevision: revision(original),
          confirmed: true,
        });
        assert.equal(result.outcome, 'applied');
        vectorStore.delete(anchor);
      }
      return texts.map(() => new Float32Array([0.5, 0.5, 0.5, 0.5]));
    },
  };
  try {
    await builder.rebuild({ deferThreadIndexing: true });
    builder.setEmbedDeps({ embedding, vectorStore });
    await builder.embedMissingDocumentVectors();
    assert.ok(
      db.prepare('SELECT anchor FROM evidence_vectors WHERE anchor=?').get(anchor),
      'an active published Taste still obtains its semantic projection',
    );
    await f.evidence.deleteByAnchor(anchor);
    vectorStore.delete(anchor);
    forgetDuringEmbed = true;
    await builder.refreshPublishedDocuments();
    await builder.embedMissingDocumentVectors();
    assert.equal(forgotten, true, 'the owner action must occur during the awaited provider call');
    assert.equal(await f.evidence.getByAnchor(anchor), null);
    assert.equal(db.prepare('SELECT anchor FROM evidence_vectors WHERE anchor=?').get(anchor), undefined);
    assert.equal(db.prepare('SELECT anchor FROM document_vector_sources WHERE anchor=?').get(anchor), undefined);
  } finally {
    await projection.stop();
    f.evidence.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
