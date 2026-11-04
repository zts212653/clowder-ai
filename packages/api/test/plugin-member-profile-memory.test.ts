import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import { createMemberProfileMemory } from '../src/domains/plugin/member-sessions/profile-memory.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'member-profile-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = new FileProfileRepository({
    dataDir,
    relationshipKeyForCat: (id) => (id === 'codex' ? 'maine-coon' : 'other'),
  });
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await put(repository.corpusPath('owner'), '家里认可的共同生活事实。');
  await put(repository.primerPath(repository.scope('owner', 'codex')), '我与主人的真实关系记忆。');
  await put(repository.primerPath(repository.scope('owner', 'opus')), 'OTHER_CAT_PRIVATE_MEMORY');
  const scope = {
    pluginInstanceId: 'installed',
    packageDigest: 'package',
    ownerUserId: 'owner',
    catId: 'codex',
    assertCurrent: async () => {},
  };
  return { repository, scope, port: createMemberProfileMemory(repository), put };
}

test('approved references resolve the actual owner corpus and this member relationship snapshot', async (t) => {
  const f = await fixture(t);
  const refs = await f.port.list(f.scope);
  assert.equal(refs.length, 2);
  assert.equal(JSON.stringify(refs).includes('PRIVATE_MEMORY'), false);
  assert.equal(JSON.stringify(refs).includes('text'), false);
  const corpus = await f.port.resolve(refs[0], f.scope);
  const own = await f.port.resolve(refs[1], f.scope);
  assert.equal(corpus.text, '家里认可的共同生活事实。');
  assert.equal(own.text, '我与主人的真实关系记忆。');
  assert.equal('path' in own, false);
});

test('a member reference cannot choose another relationship, file, owner URI, or stale revision', async (t) => {
  const f = await fixture(t);
  const [ref] = await f.port.list(f.scope);
  for (const sourceRef of [
    '/etc/passwd',
    'file:///etc/passwd',
    'cat-cafe-profile://relationship/other/current',
    'cat-cafe-profile://corpus/foreign/current',
  ]) {
    await assert.rejects(() => f.port.resolve({ ...ref, sourceRef }, f.scope), /unsupported_member_memory/);
  }
  await f.put(f.repository.corpusPath('owner'), '新版本。');
  await assert.rejects(() => f.port.resolve(ref, f.scope), /memory_changed/);
});

test('missing or oversized memory remains unavailable rather than falling back to home engineering context', async (t) => {
  const f = await fixture(t);
  const [, ref] = await f.port.list(f.scope);
  await rm(f.repository.primerPath(f.repository.scope('owner', 'codex')));
  await assert.rejects(() => f.port.resolve(ref, f.scope), /memory_unavailable/);
  await f.put(f.repository.corpusPath('owner'), 'x'.repeat(65537));
  await assert.rejects(() => f.port.list(f.scope), /memory_too_large/);
});
