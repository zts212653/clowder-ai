import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../docs/plans/2026-10-29-role-agent-refactor/quality-review-samples/', import.meta.url);
const load = (path) => import(new URL(path, root));

test('Q02 material and calibration bytes match the frozen private manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.keyVersion, 1);
  assert.equal(manifest.files.length, 9);
  for (const file of manifest.files) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL(file.path, root)))
        .digest('hex'),
      file.sha256,
    );
  }
  assert.equal(
    createHash('sha256')
      .update(readFileSync(import.meta.filename))
      .digest('hex'),
    manifest.calibrationSha256,
  );
});

test('Q02-A ground truth: the cache change discloses an owner document to another caller', async () => {
  const document = Object.freeze({ id: 'doc', ownerId: 'alice', body: 'private-fixture' });
  for (const version of ['before', 'after']) {
    let reads = 0;
    const { createDocumentReader } = await load(`Q02-A/${version}/src/documents.mjs`);
    const read = createDocumentReader({
      find: async (id) => {
        reads++;
        return id === document.id ? document : null;
      },
    });
    assert.equal(await read('bob', 'doc'), null, 'a cold denied read is the control');
    assert.deepEqual(await read('alice', 'doc'), document);
    const actual = await read('bob', 'doc');
    if (version === 'before') assert.equal(actual, null);
    else assert.deepEqual(actual, document, 'the known regression must remain reproducible');
    assert.equal(await read('alice', 'missing'), null);
    assert.equal(reads, version === 'before' ? 4 : 3);
  }
});

test('Q02-B ground truth: removing the owner lock admits concurrent reservations beyond the limit', async () => {
  for (const version of ['before', 'after']) {
    let used = 0;
    let pending = Promise.resolve();
    const store = {
      get: async () => used,
      set: async (_key, value) => {
        used = value;
      },
      withLock(_key, run) {
        const result = pending.then(run);
        pending = result.then(() => undefined);
        return result;
      },
    };
    const { reserve } = await load(`Q02-B/${version}/src/reserve.mjs`);
    const receipts = await Promise.all([reserve(store, 'bucket', 4, 5), reserve(store, 'bucket', 4, 5)]);
    assert.deepEqual(receipts, version === 'before' ? [true, false] : [true, true]);
    assert.equal(used, 4, 'persisted count alone conceals the over-admission');
    assert.equal(await reserve(store, 'bucket', 2, 5), false, 'sequential refusal is the control');
    assert.equal(used, 4);
  }
});

test('Q02-C healthy control preserves the complete declared contract without mutating input', async () => {
  const cases = [[], ['  ', '\t'], [' Cat ', 'cat', 'DOG', '', ' dog ', 'Bird'], ['B', 'a', 'A', ' b ']];
  const expected = [[], [], ['Cat', 'DOG', 'Bird'], ['B', 'a']];
  for (const version of ['before', 'after']) {
    const { normalizeTags } = await load(`Q02-C/${version}/src/tags.mjs`);
    cases.forEach((tags, index) => {
      const input = Object.freeze([...tags]);
      assert.deepEqual(normalizeTags(input), expected[index]);
      assert.deepEqual(input, tags);
    });
  }
});
