import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

for (const deniedAt of [1, 2]) {
  test(`ordinary settlement denied at authority fence ${deniedAt} leaves the original manifest and receipt intact`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'f326-settlement-authority-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const owner = new ProjectContentOwnerService({ dataDir });
    const original = await owner.importContent({
      contentRef: 'work:authority',
      bytes: Buffer.from('original'),
      mediaType: 'image/png',
      actor: { kind: 'human', actorId: 'operator' },
      operationId: 'original',
    });
    let authorizations = 0;
    await assert.rejects(
      owner.settle({
        contentRef: original.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'candidate',
        actor: { kind: 'cat', actorId: 'director' },
        bytes: Buffer.from('candidate'),
        authorizeEffect: async () => {
          authorizations += 1;
          if (authorizations === deniedAt) throw new Error('producer authority ended');
        },
      }),
      /producer authority ended/,
    );
    assert.equal(authorizations, deniedAt);
    const reopened = new ProjectContentOwnerService({ dataDir });
    assert.equal((await reopened.describe(original.contentRef)).currentOwnerRevision, 1);
    assert.deepEqual((await reopened.load(original.contentRef)).bytes, Buffer.from('original'));
    assert.deepEqual(await reopened.listOutbox(original.contentRef), [original]);
  });
}
