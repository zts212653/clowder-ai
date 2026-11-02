import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileMessagingMediaLedger } from '../dist/domains/messaging/media-ledger.js';
import { createHostMediaPathResolver } from '../dist/domains/messaging/outbound-media/host-media-paths.js';

let root;
let roots;
let resolvePath;
const file = '中文 目录/媒体 文件.mp3';
const mappings = [
  { key: 'uploadDir', prefix: '/uploads/', dir: '', parentSuffix: '..' },
  { key: 'ttsCacheDir', prefix: '/api/tts/audio/', dir: '', parentSuffix: '..' },
  { key: 'connectorMediaDir', prefix: '/api/connector-media/', dir: '', parentSuffix: '..' },
  { key: 'webPublicDir', prefix: '/avatars/', dir: 'avatars', parentSuffix: '../..' },
];

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-media-paths-'));
  roots = {
    uploadDir: join(root, 'uploads'),
    ttsCacheDir: join(root, 'tts'),
    connectorMediaDir: join(root, 'connector-media'),
    webPublicDir: join(root, 'web'),
  };
  await writeFile(join(root, 'outside.mp3'), 'outside');
  await Promise.all(
    mappings.map(async ({ key, dir }) => {
      const base = join(roots[key], dir);
      await mkdir(join(base, '中文 目录'), { recursive: true });
      await writeFile(join(base, file), 'media');
      await writeFile(join(base, '..合法.mp3'), 'dot name');
      await mkdir(`${roots[key]}-sibling`);
      await writeFile(join(`${roots[key]}-sibling`, 'outside.mp3'), 'sibling');
    }),
  );
  resolvePath = createHostMediaPathResolver(roots);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('Host media paths with the running platform resolver', () => {
  mappings.forEach(({ key, prefix, dir, parentSuffix }) => {
    test(`${prefix} resolves an existing native child with Chinese and spaces`, () => {
      const expected = resolve(roots[key], dir, file);
      assert.ok(existsSync(expected), 'the fixture must exist before calling the real resolver');
      assert.equal(resolvePath(`${prefix}${file}`), expected, `native separator: ${JSON.stringify(sep)}`);
      assert.equal(resolvePath(`${prefix}..合法.mp3`), join(roots[key], dir, '..合法.mp3'));
    });

    test(`${prefix} rejects traversal and same-prefix sibling directories`, () => {
      assert.ok(existsSync(join(root, 'outside.mp3')));
      assert.equal(resolvePath(`${prefix}${parentSuffix}/outside.mp3`), undefined);
      const sibling = `${parse(roots[key]).base}-sibling`;
      assert.ok(existsSync(join(root, sibling, 'outside.mp3')));
      assert.equal(resolvePath(`${prefix}${parentSuffix}/${sibling}/outside.mp3`), undefined);
    });

    test(`${prefix} preserves missing-file and root-directory candidate behavior`, () => {
      assert.equal(resolvePath(`${prefix}missing.mp3`), undefined);
      assert.equal(resolvePath(`${prefix}${dir ? '..' : ''}`), roots[key]);
    });
  });

  test('rejects existing absolute paths outside the root', () => {
    assert.equal(resolvePath(`/uploads/${join(root, 'outside.mp3')}`), undefined);
    assert.equal(resolvePath(`/uploads/${parse(root).root}`), undefined);
    assert.equal(resolvePath(`/api/tts/audio/${join(roots.uploadDir, file)}`), undefined);
  });

  test('preserves the avatars mapping relative to webPublicDir', async () => {
    const path = join(roots.webPublicDir, 'shared.png');
    await writeFile(path, 'public');
    assert.equal(resolvePath('/avatars/../shared.png'), path);
  });

  test('leaves regular-file validation to the media ledger', async () => {
    const path = resolvePath('/uploads/');
    assert.equal(path, roots.uploadDir, 'an existing directory remains a candidate');
    const ledger = new FileMessagingMediaLedger(join(root, 'ledger'));
    await assert.rejects(ledger.register({ path }), /regular file/);
  });

  test('does not decode URL suffixes or expand the route whitelist', async () => {
    await mkdir(join(roots.uploadDir, '%2e%2e'));
    const literal = join(roots.uploadDir, '%2e%2e', 'literal.mp3');
    await writeFile(literal, 'literal');
    assert.equal(resolvePath('/uploads/%2e%2e/literal.mp3'), literal);
    [
      '',
      '/uploads',
      '/unknown/file.mp3',
      '/api/media/hmr/id',
      'https://host/uploads/file.mp3',
      'file:///tmp/a',
    ].forEach((url) => {
      assert.equal(resolvePath(url), undefined);
    });
  });

  test('uses Windows backslash and UNC semantics', { skip: process.platform !== 'win32' }, () => {
    assert.equal(resolvePath(`/uploads/${file.replaceAll('/', '\\')}`), join(roots.uploadDir, file));
    assert.equal(resolvePath('/uploads/..\\outside.mp3'), undefined);
    assert.equal(resolvePath('/uploads/..\\uploads-sibling\\outside.mp3'), undefined);
    assert.equal(resolvePath('/uploads/\\\\other-host\\share\\outside.mp3'), undefined);
  });

  test('rejects an existing file on another Windows volume', { skip: process.platform !== 'win32' }, (t) => {
    const target = [process.execPath, fileURLToPath(import.meta.url)].find(
      (path) => parse(path).root.toLowerCase() !== parse(root).root.toLowerCase(),
    );
    if (!target) {
      t.skip('no file on another volume is available');
      return;
    }
    assert.ok(existsSync(target), 'the cross-volume target must exist');
    assert.equal(resolvePath(`/uploads/${target}`), undefined);
  });

  test('preserves literal backslashes on POSIX', { skip: process.platform === 'win32' }, async () => {
    const literal = '..\\outside.mp3';
    const path = join(roots.uploadDir, literal);
    await writeFile(path, 'literal backslash');
    assert.equal(resolvePath(`/uploads/${literal}`), path);
    assert.notEqual(path, join(root, 'outside.mp3'));
  });
});
