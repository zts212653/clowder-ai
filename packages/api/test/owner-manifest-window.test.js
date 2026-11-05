import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { collect, interceptManifestReads, ownerManifestFixture } from './helpers/owner-manifest-fixture.js';

const readers = {
  retained: (f) => collect(f.store.retainedMediaHeads('owner')),
  publication: (f) => f.store.findSourcePublicationsBatch([f.lookup]),
  projects: (f) => f.store.listVideoProjects('owner'),
};

for (const [name, read] of Object.entries(readers)) {
  test(`${name} admits four canonical reads, bounds the window and consumes every manifest`, async (t) => {
    const f = await ownerManifestFixture(t);
    // Establish valid real files and expected output before interposing only read completion.
    const expected = await read(f);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let admitted;
    const first = new Promise((resolve) => {
      admitted = resolve;
    });
    const counter = interceptManifestReads(t, f, async ({ path, args, original }) => {
      admitted();
      await gate;
      return original(path, ...args);
    });
    const running = read(f);
    try {
      await first;
      await setImmediate();
      assert.equal(counter.stats().active, 4, 'independent reads must share one bounded four-file window');
      assert.equal(counter.stats().paths.length, 4, 'a blocked window must not admit the whole catalogue');
    } finally {
      release();
      assert.deepEqual(await running, expected);
      assert.equal(counter.stats().active, 0);
      assert.equal(counter.stats().peak, 4);
      assert.equal(counter.stats().paths.length, f.refs.length);
      assert.equal(new Set(counter.stats().paths).size, f.refs.length);
    }
  });
}

test('all three complete readers retain owner/type/source filters and ignore noncanonical entries', async (t) => {
  const f = await ownerManifestFixture(t);
  for (const ownerUserId of ['owner', 'foreign']) {
    const projectId = `fixture-${ownerUserId}`;
    await f.service.importContent({
      contentRef: `video-project:${projectId}`,
      mediaType: 'application/vnd.cat-cafe.video-project+json',
      bytes: Buffer.from('{}'),
      operationId: `project-${ownerUserId}`,
      actor: { kind: 'human', actorId: ownerUserId },
      projectScope: { kind: 'video-project', ownerUserId, projectId },
      operationContext: { kind: 'video-project:create', requestDigest: `sha256:${'1'.repeat(64)}` },
    });
  }
  await f.service.importContent({
    contentRef: 'prepared-media:foreign',
    bytes: Buffer.from('foreign'),
    mediaType: 'image/png',
    operationId: 'foreign',
    actor: { kind: 'human', actorId: 'foreign' },
    publicationScope: { ownerUserId: 'foreign', threadId: 'fixture', taskId: 'fixture' },
    sourcePublication: {
      sourceRef: f.lookup.sourceRef,
      artifactRef: f.lookup.artifactRef,
      revision: f.lookup.revisions[0],
    },
  });
  await mkdir(join(f.manifestRoot, '.in-progress'));
  await writeFile(join(f.manifestRoot, 'a'.repeat(64)), 'not a directory');
  await symlink(join(f.manifestRoot, '.in-progress'), join(f.manifestRoot, 'b'.repeat(64)));
  const manifestBytes = new Set();
  let decodes = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (raw, ...args) => {
    if (manifestBytes.has(raw)) decodes++;
    return parse(raw, ...args);
  });
  const counter = interceptManifestReads(t, f, async ({ path, args, original }) => {
    const raw = await original(path, ...args);
    manifestBytes.add(raw);
    return raw;
  });
  assert.deepEqual((await readers.retained(f)).map((head) => head.contentRef).sort(), [...f.refs].sort());
  assert.deepEqual(await readers.projects(f), [
    {
      contentRef: 'video-project:fixture-owner',
      projectScope: { kind: 'video-project', ownerUserId: 'owner', projectId: 'fixture-owner' },
    },
  ]);
  const matches = (await readers.publication(f)).get('all');
  assert.deepEqual(
    matches.map((match) => match.contentRef),
    [...f.refs].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(counter.stats().paths.length, 3 * 12, 'every valid manifest is freshly read by each consumer');
  assert.equal(
    decodes,
    counter.stats().paths.length,
    'each fresh canonical manifest is decoded once, then fully validated',
  );
});
