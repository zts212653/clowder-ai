import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, unlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { screeningFixture } from './helpers/video-project-screening.js';

async function padMovie(path: string, byteLength: number) {
  const handle = await open(path, 'r+');
  try {
    const { size } = await handle.stat();
    const atom = Buffer.alloc(8);
    atom.writeUInt32BE(byteLength - size, 0);
    atom.write('free', 4, 'ascii');
    await handle.write(atom, 0, atom.length, size);
    await handle.truncate(byteLength);
  } finally {
    await handle.close();
  }
}

test('a workspace video snapshot stays frozen and streams bounded chunks after the source changes', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  await padMovie(fixture.path, 1024 * 1024);
  const input = { principal: fixture.principal, locator: fixture.request.source.locator };
  const source = await fixture.workspace.describe(input);
  const opened = await fixture.workspace.openMedia({ ...input, expectedRevision: source.revision });
  await writeFile(fixture.path, 'the mutable original has been replaced');
  const digest = createHash('sha256');
  let bytes = 0;
  let largestChunk = 0;
  for await (const chunk of opened.stream) {
    assert.ok(Buffer.isBuffer(chunk));
    bytes += chunk.length;
    largestChunk = Math.max(largestChunk, chunk.length);
    digest.update(chunk);
  }
  assert.equal(bytes, source.byteLength);
  assert.equal(`sha256:${digest.digest('hex')}`, source.revision);
  assert.ok(largestChunk <= 256 * 1024, `snapshot emitted one ${largestChunk}-byte allocation`);
});

test('a real MP4 larger than the text collaboration limit can be described, probed and streamed', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const byteLength = 65 * 1024 * 1024;
  await padMovie(fixture.path, byteLength);
  const input = { principal: fixture.principal, locator: fixture.request.source.locator };
  const source = await fixture.workspace.describe(input);
  assert.equal(source.byteLength, byteLength);
  const opened = await fixture.workspace.openMedia({ ...input, expectedRevision: source.revision });
  assert.equal(opened.media.kind, 'video');
  let actual = 0;
  for await (const chunk of opened.stream) actual += chunk.length;
  assert.equal(actual, byteLength);
  await assert.rejects(
    fixture.workspace.openMedia({ ...input, expectedRevision: `sha256:${'0'.repeat(64)}` }),
    /revision_changed/,
  );
  const text = await open(`${fixture.root}/oversize.txt`, 'w');
  await text.truncate(byteLength);
  await text.close();
  await assert.rejects(
    fixture.workspace.describe({ ...input, locator: { worktreeId: 'root', path: 'oversize.txt' } }),
    /too_large/,
  );
});

test('screening registration freezes a greater-than-256MiB original and retries without loading the whole movie', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const byteLength = 257 * 1024 * 1024;
  await padMovie(fixture.path, byteLength);
  const source = await fixture.workspace.describe({
    principal: fixture.principal,
    locator: fixture.request.source.locator,
  });
  const request = {
    ...fixture.request,
    source: { ...fixture.request.source, expectedSourceRevision: source.revision },
  };
  const saved = await fixture.make().register(request);
  assert.equal((await fixture.owner.describe(saved.screening.media.contentRef, 1)).byteLength, byteLength);
  const load = fixture.owner.load.bind(fixture.owner);
  fixture.owner.load = async (contentRef, revision) => {
    assert.ok(!contentRef.startsWith('video-project-media:'), 'recovery must not buffer the retained movie');
    return load(contentRef, revision);
  };
  await unlink(fixture.path);
  assert.deepEqual(await fixture.make().register(request), saved);
});
