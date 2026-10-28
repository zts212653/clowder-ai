import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canLaunchLocalFile,
  contentFileMime,
  fileContentKind,
  isContentFileBasename,
  projectFileContent,
} from '../content-file.js';

test('catalogue category and viewer facts do not diverge for a published media file', () => {
  const input = { type: 'file', name: '片段.mp4', url: '/uploads/copy.mp4' };
  assert.deepEqual(projectFileContent(input), {
    name: '片段.mp4',
    mime: 'video/mp4',
    kind: 'video',
    floating: true,
  });
  assert.equal(input.type, 'file');
  assert.equal(projectFileContent({ name: '未命名', url: '/uploads/cover.png' }).kind, 'image');
  assert.equal(projectFileContent({ name: '未命名', url: '/uploads/archive.zip' }).kind, 'binary');
  assert.equal(fileContentKind('download', 'application/pdf'), 'office');
  assert.equal(projectFileContent({ name: 'report.mp4', mime: 'application/pdf' }).kind, 'office');
  assert.equal(projectFileContent({ name: 'poster.png', mime: 'text/plain' }).kind, 'text');
  assert.equal(projectFileContent({ name: 'clip.mkv', mime: 'application/octet-stream' }).kind, 'video');
  assert.equal(fileContentKind('cover.ico', 'application/octet-stream'), 'image');
});
test('literal names keep # and ? characters; URL transport is decoded separately', () => {
  assert.equal(contentFileMime('稿件#2?.md'), 'text/markdown');
  assert.equal(contentFileMime('image.png#draft'), 'application/octet-stream');
  assert.equal(
    projectFileContent({ name: '图片', type: 'image', url: '/uploads/a%23b.png?download=1' }).mime,
    'image/png',
  );
  assert.equal(contentFileMime('LICENSE'), 'text/plain');
  assert.equal(fileContentKind('LICENSE'), 'text');
});
test('Unicode upload basenames are real names, never a path or encoded separator', () => {
  assert.equal(isContentFileBasename('doc-0a6831f6718f-Clowder_AI_后续建设与分工讨论稿-v0_2.md'), true);
  for (const name of ['', '.', '..', 'a/b.md', 'a\\b.md', 'x\u0000.md', 'x\n.md'])
    assert.equal(isContentFileBasename(name), false, name);
});
test('launch policy does not decide whether an object exists locally', () => {
  for (const name of ['稿件.md', 'LICENSE', 'photo.PNG', 'movie.mp4'])
    assert.equal(canLaunchLocalFile(name), true, name);
  for (const name of [
    'run.command',
    'run.sh',
    'run.py',
    'run.PY',
    'run.js',
    'run.mjs',
    'run.fish',
    'run.pl',
    'run.rb',
    'run.php',
    'run.psm1',
    'archive.zip',
    'unknown.bin',
    'app.exe',
    'folder.app',
  ])
    assert.equal(canLaunchLocalFile(name), false, name);
});
