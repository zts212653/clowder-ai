import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../dist/domains/collaborative-content/artifact-review/store.js';
import { readIndependentThreadWorks, WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { LivingWorkService } from '../dist/domains/collaborative-content/works/service.js';
import { ProjectContentOwnerService } from '../dist/domains/video-studio/content-owner/service.js';

test('complete independent Works reads canonical manifests at most twice, with fresh selected versions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task229-work-catalogue-'));
  const owner = new ProjectContentOwnerService({ dataDir: root });
  const versions = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  t.after(async () => {
    versions.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('synthetic retained work bytes');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const service = new LivingWorkService({
    owner,
    versions: versions.works,
    authorize: async ({ principal, scope }) => {
      if (scope) assert.equal(scope.ownerUserId, principal.userId);
    },
    source: {
      openCurrent: async () => {
        throw new Error('catalogue must not open current workspace files');
      },
      open: async () => ({
        stream: Readable.from([bytes]),
        byteLength: bytes.length,
        blobDigest: digest,
        mediaType: 'video/mp4',
        publication: { sourceRef: 'workspace:fixture:film.mp4', artifactRef: 'film.mp4', revision: digest },
        revalidate: async () => undefined,
      }),
      inspect: async () => {
        throw new Error('catalogue must not inspect workspace bytes');
      },
    },
  });
  const expected = [];
  const rawCount = 61;
  const selectedCount = 21;
  for (let i = 0; i < rawCount; i++) {
    const threadId = i < selectedCount ? 'selected-thread' : 'another-thread';
    const result = await service.commit(
      {
        action: 'create',
        operationId: `film-${i}`,
        title: `Film ${i}`,
        changeSummary: 'Synthetic version',
        source: { worktreeId: 'fixture', path: 'film.mp4', expectedSourceRevision: digest },
      },
      { userId: 'owner', threadId, actor: { kind: 'human', actorId: 'owner' } },
    );
    if (i < selectedCount) expected.push(result.reference.contentRef);
  }
  let stateReads = 0;
  let manifestBytes = 0;
  const originalRead = fs.readFile;
  fs.readFile = async (path, ...args) => {
    const value = await originalRead(path, ...args);
    if (String(path).startsWith(join(root, 'projects', 'content-owner-v1')) && String(path).endsWith('/state.json')) {
      stateReads++;
      manifestBytes += Buffer.byteLength(value);
    }
    return value;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = originalRead;
    syncBuiltinESMExports();
  });
  const started = performance.now();
  const artifacts = await readIndependentThreadWorks(new WorkCatalogue(service), 'owner', 'selected-thread');
  assert.equal(artifacts.length, selectedCount);
  assert.deepEqual(
    artifacts.map((item) => item.ref),
    expected.sort((a, b) => a.localeCompare(b)),
  );
  assert.ok(artifacts.every((item) => item.work.ownerRevision === 1 && item.work.currentOwnerRevision === 1));
  assert.ok(
    artifacts.every((item) => item.sourceMessageId === null),
    'silent owner saves remain independent works',
  );
  t.diagnostic(
    JSON.stringify({ rawCount, selectedCount, stateReads, manifestBytes, elapsedMs: performance.now() - started }),
  );
  // Two full fresh discovery passes plus at most three point reads per selected version.
  assert.ok(stateReads <= 2 * rawCount + 3 * selectedCount, `canonical manifest read budget exceeded: ${stateReads}`);
});
