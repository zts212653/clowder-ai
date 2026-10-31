import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { projectReviewHttpFixture } from './helpers/video-project-review-http.js';

const owner = 'operator',
  contentRef = 'video-project:cursor-test',
  threadId = 'thread-cursor';
const point = (version: 1 | 2, n: number) =>
  cursorFor({ id: `message-${n}`, ...(version === 2 ? { visibilitySeq: n } : {}) });
async function sqliteFixture() {
  const root = await mkdtemp(join(tmpdir(), 'f326-import-cursor-'));
  const path = join(root, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(path);
  return {
    get cursor() {
      return store.ledgers.projectMessageImports;
    },
    restart() {
      store.close();
      store = new ArtifactReviewStore(path);
    },
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
for (const version of [1, 2] as const) {
  test(`F326 v${version} successful identical and covered older pages acknowledge monotonically across SQLite restart`, async (t) => {
    const f = await sqliteFixture();
    t.after(f.cleanup);
    const first = point(version, 1),
      latest = point(version, 3);
    f.cursor.advance(owner, contentRef, threadId, undefined, latest);
    assert.doesNotThrow(() => f.cursor.advance(owner, contentRef, threadId, undefined, latest));
    assert.doesNotThrow(() => f.cursor.advance(owner, contentRef, threadId, undefined, first));
    assert.equal(f.cursor.get(owner, contentRef, threadId), latest);
    f.restart();
    assert.doesNotThrow(() => f.cursor.advance(owner, contentRef, threadId, first, point(version, 2)));
    assert.equal(f.cursor.get(owner, contentRef, threadId), latest);
  });
  test(`F326 v${version} uncovered future pages and matched-CAS regression remain conflicts`, async (t) => {
    const f = await sqliteFixture();
    t.after(f.cleanup);
    const first = point(version, 1),
      current = point(version, 2),
      next = point(version, 3);
    f.cursor.advance(owner, contentRef, threadId, undefined, current);
    assert.throws(() => f.cursor.advance(owner, contentRef, threadId, undefined, next), { code: 'revision_conflict' });
    assert.throws(() => f.cursor.advance(owner, contentRef, threadId, first, next), { code: 'revision_conflict' });
    assert.throws(() => f.cursor.advance(owner, contentRef, threadId, current, first), { code: 'revision_conflict' });
    assert.equal(f.cursor.get(owner, contentRef, threadId), current);
    f.cursor.advance(owner, contentRef, threadId, current, next);
    assert.equal(f.cursor.get(owner, contentRef, threadId), next);
  });
}
for (const [storedVersion, pageVersion] of [
  [1, 2],
  [2, 1],
] as const)
  test(`F326 v${storedVersion}/v${pageVersion} comparator indeterminacy cannot acknowledge a conflicting page`, async (t) => {
    const f = await sqliteFixture();
    t.after(f.cleanup);
    const current = point(storedVersion, 2);
    f.cursor.advance(owner, contentRef, threadId, undefined, current);
    assert.throws(() => f.cursor.advance(owner, contentRef, threadId, undefined, point(pageVersion, 2)), {
      code: 'revision_conflict',
    });
    assert.equal(f.cursor.get(owner, contentRef, threadId), current);
    f.restart();
    assert.throws(() => f.cursor.advance(owner, contentRef, threadId, undefined, point(pageVersion, 1)), {
      code: 'revision_conflict',
    });
    assert.equal(f.cursor.get(owner, contentRef, threadId), current);
  });

test('F326 matched legacy-page CAS permits canonical promotion but prevents v2 downgrade', async (t) => {
  const f = await sqliteFixture();
  t.after(f.cleanup);
  const legacy = point(1, 1),
    canonical = point(2, 2);
  f.cursor.advance(owner, contentRef, threadId, undefined, legacy);
  f.cursor.advance(owner, contentRef, threadId, legacy, canonical);
  assert.equal(f.cursor.get(owner, contentRef, threadId), canonical);
  assert.throws(() => f.cursor.advance(owner, contentRef, threadId, canonical, point(1, 3)), {
    code: 'revision_conflict',
  });
  assert.equal(f.cursor.get(owner, contentRef, threadId), canonical);
});

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function sync(f: Awaited<ReturnType<typeof projectReviewHttpFixture>>, limit: number) {
  return f.importer.synchronize({
    principal: f.principal,
    contentRef: f.request.contentRef,
    threadId: f.thread.id,
    limit,
  });
}
for (const scenario of ['covered-older-page', 'uncovered-future-page', 'partially-failed-page'] as const)
  test(`F326 actual owner/MessageStore/SQLite overlapping pages: ${scenario}`, async (t) => {
    const f = await projectReviewHttpFixture();
    t.after(f.cleanup);
    const sources = [f.append(), f.append(), f.append()];
    const last = sources[2];
    assert.ok(last);
    const pause = gate(),
      paused = gate();
    const importer = f.importer;
    const original = importer.import.bind(importer);
    let held = false;
    importer.import = async (input) => {
      const blockId = scenario === 'covered-older-page' ? sources[0]?.id : last.id;
      if (!held && input.messageId === blockId && scenario === 'partially-failed-page') {
        held = true;
        paused.release();
        await pause.wait;
        throw new Error('Injected incomplete-page acknowledgement');
      }
      const result = await original(input);
      if (!held && input.messageId === blockId) {
        held = true;
        paused.release();
        await pause.wait;
      }
      return result;
    };
    const pending = sync(f, scenario === 'covered-older-page' ? 1 : 3);
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await paused.wait;
    const completed = await sync(f, scenario === 'covered-older-page' ? 3 : 1);
    pause.release();
    const result = await outcome;
    if (scenario === 'covered-older-page') {
      assert.ok('value' in result);
      assert.equal(result.value.cursor, completed.cursor, 'ack exposes the actual retained position');
    } else {
      assert.ok('error' in result);
      if (scenario === 'uncovered-future-page')
        assert.equal((result.error as { code: string }).code, 'revision_conflict');
    }
    assert.equal(
      f.store.ledgers.projectMessageImports.get(f.principal.userId, f.request.contentRef, f.thread.id),
      completed.cursor,
    );
    assert.equal(
      f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations.length,
      scenario === 'partially-failed-page' ? 2 : 3,
    );
    await f.restart();
    const recovered = await sync(f, 3);
    assert.equal(recovered.scanned, scenario === 'covered-older-page' ? 0 : 2);
    assert.equal(
      f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations.length,
      3,
      'retained successful rows replay without another opinion',
    );
    assert.equal(
      f.store.ledgers.projectMessageImports.get(f.principal.userId, f.request.contentRef, f.thread.id),
      cursorFor(last),
    );
  });
