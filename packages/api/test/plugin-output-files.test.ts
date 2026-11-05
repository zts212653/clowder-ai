import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileOutputOperations } from '../src/domains/plugin/outputs/file-output-operations.js';
import { ProjectOutputFiles } from '../src/domains/plugin/outputs/project-output-files.js';

async function directories(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, journal: join(root, '.host-output') };
}
test('operation CAS is durable across independent adapters and admits only one next revision', async (t) => {
  const { journal } = await directories(t);
  const first = new FileOutputOperations(journal);
  const second = new FileOutputOperations(journal);
  const row = { id: 'operation-one', digest: 'a'.repeat(64), revision: 1, phase: 'preparing' as const };
  assert.equal(await first.create(row), true);
  assert.equal(await second.create(row), false);
  const outcomes = await Promise.all([
    first.replace(1, { ...row, revision: 2, phase: 'dispatched' }),
    second.replace(1, { ...row, revision: 2, phase: 'rejected' }),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await new FileOutputOperations(journal).get(row.id))?.revision, 2);
});
test('reserves both targets before production and never overwrites a preexisting sidecar', async (t) => {
  const { root, journal } = await directories(t);
  const files = new ProjectOutputFiles(journal);
  await writeFile(join(root, 'song.mp3.provenance.json'), 'existing');
  await assert.rejects(files.reserve('op-one', root, 'song.mp3'), /target_conflict/);
  await assert.rejects(readFile(join(root, 'song.mp3')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'song.mp3.provenance.json'), 'utf8'), 'existing');
  await unlink(join(root, 'song.mp3.provenance.json'));
  await files.reserve('op-two', root, 'song.mp3');
  await assert.rejects(files.reserve('op-three', root, 'song.mp3'), /target_conflict/);
});
test('restart resumes a partially delivered pair only on the original owned inodes', async (t) => {
  const { root, journal } = await directories(t);
  const files = new ProjectOutputFiles(journal);
  const reservation = await files.reserve('op-one', root, 'song.mp3');
  // A crash after the MP3 write but before the sidecar commit.
  await writeFile(join(root, 'song.mp3'), Buffer.from('ID3the-audio'));
  const resumed = new ProjectOutputFiles(journal);
  await resumed.deliver(reservation, Buffer.from('ID3the-audio'), { model: 'fixture', actualChargedUsd: null });
  assert.equal(await readFile(join(root, 'song.mp3'), 'utf8'), 'ID3the-audio');
  assert.equal(JSON.parse(await readFile(join(root, 'song.mp3.provenance.json'), 'utf8')).model, 'fixture');
  await resumed.deliver(reservation, Buffer.from('ID3the-audio'), { model: 'fixture', actualChargedUsd: null });
  await unlink(join(root, 'song.mp3'));
  await writeFile(join(root, 'song.mp3'), 'someone-else');
  await assert.rejects(
    resumed.deliver(reservation, Buffer.from('ID3the-audio'), { model: 'fixture' }),
    /target_changed/,
  );
  assert.equal(await readFile(join(root, 'song.mp3'), 'utf8'), 'someone-else');
});
test('symlink parents and post-reservation directory swaps cannot redirect delivery', async (t) => {
  const { root, journal } = await directories(t);
  const outside = await mkdtemp(join(tmpdir(), 'plugin-output-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'linked'));
  const files = new ProjectOutputFiles(journal);
  await assert.rejects(files.reserve('op-linked', root, 'linked/song.mp3'), /path_not_allowed/);
  await assert.rejects(files.reserve('op-escape', root, '../escape.mp3'), /path_not_allowed/);
  const reservation = await files.reserve('op-one', root, 'scores/song.mp3');
  await rm(join(root, 'scores'), { recursive: true });
  await symlink(outside, join(root, 'scores'));
  await assert.rejects(
    files.deliver(reservation, Buffer.from('ID3audio'), { model: 'fixture' }),
    /path_not_allowed|target_changed/,
  );
  await assert.rejects(readFile(join(outside, 'song.mp3')), { code: 'ENOENT' });
});
