import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import {
  createWorkContextSource,
  MAX_VIDEO_WORK_INDEX_BYTES,
} from '../src/domains/collaborative-content/works/context-source.js';
import { WorkVideoContextService } from '../src/domains/collaborative-content/works/video-context.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('video index import rejects changed, malformed, oversized, wrong-format and unauthorized sources without retaining partial metadata', async (t) => {
  const film = await screeningFixture();
  const store = new ArtifactReviewStore(`${film.root}/index-import.sqlite`);
  t.after(async () => {
    store.close();
    await film.cleanup();
  });
  const principal = {
    userId: 'operator',
    threadId: 'thread-film',
    actor: { kind: 'human' as const, actorId: 'operator' },
  };
  const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
  const locator = { worktreeId: 'root', path: 'index.json' };
  const context = {
    format: 'video',
    extractorVersion: 'v1',
    provenance: [{ ref: 'timeline.json', digest: `sha256:${'b'.repeat(64)}` }],
    story: [],
    assets: [],
  };
  let allowed = true,
    changeDuringProbe = false,
    sourceReads = 0;
  const open = createWorkContextSource(film.workspace);
  const service = new WorkVideoContextService({
    store: store.works.contexts,
    authorize: async () => {
      if (!allowed) throw new Error('work revoked');
    },
    contextSource: async (source, who) => {
      sourceReads++;
      return open(source, who);
    },
    media: async () => {
      if (changeDuringProbe)
        await writeFile(`${film.root}/index.json`, JSON.stringify({ ...context, extractorVersion: 'changed' }));
      return { kind: 'video', streamId: '0', startTick: 0, durationTicks: 100 };
    },
  });
  let attempt = 0;
  const command = async (body: string) => {
    await writeFile(`${film.root}/index.json`, body);
    const source = await film.workspace.describe({ principal: { userId: 'operator' }, locator });
    return {
      action: 'import-context',
      operationId: `attempt-${attempt++}`,
      reference,
      expectedMetadataRevision: 0,
      source: { ...locator, expectedSourceRevision: source.revision },
    };
  };
  for (const body of [
    '{',
    JSON.stringify({ format: 'html', body: '<script>no</script>' }),
    ' '.repeat(MAX_VIDEO_WORK_INDEX_BYTES + 1),
  ]) {
    await assert.rejects(service.import(await command(body), principal));
    assert.equal(store.works.contexts.get('operator', reference), null);
  }
  const changed = await command(JSON.stringify(context));
  changeDuringProbe = true;
  await assert.rejects(service.import(changed, principal), /revision_changed/);
  assert.equal(store.works.contexts.get('operator', reference), null);
  changeDuringProbe = false;
  const accepted = await command(JSON.stringify(context));
  const saved = await service.import(accepted, principal);
  assert.equal(saved.metadataRevision, 1);
  const count = sourceReads;
  await assert.rejects(
    service.import(
      { ...accepted, source: { ...accepted.source, expectedSourceRevision: `sha256:${'c'.repeat(64)}` } },
      principal,
    ),
    /idempotency/,
  );
  assert.equal(sourceReads, count, 'Replay conflicts do not open a new source');
  allowed = false;
  await assert.rejects(service.import(accepted, principal), /revoked/);
  assert.equal(sourceReads, count, 'Retained context is not a current authority grant');
});
