import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGzip, gzipSync } from 'node:zlib';
import { preflightPluginArchive } from '../src/domains/plugin/external-runtime/archive-preflight.ts';
import { stageVerifiedPackageArchive } from '../src/domains/plugin/external-runtime/package-staging.ts';
import { manifest } from './plugin-official-package-installer.fixture.js';

function header(name, size = 0, type = '0') {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100);
  for (const [offset, width, value] of [
    [100, 8, 0o644],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, size],
    [136, 12, 0],
  ]) {
    bytes.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width);
  }
  bytes.fill(32, 148, 156);
  bytes.write(type, 156, 1);
  bytes.write('ustar\0', 257);
  bytes.write('00', 263);
  bytes.write(
    `${[...bytes]
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    8,
  );
  return bytes;
}

function member(name, body = Buffer.alloc(0), type = '0') {
  return Buffer.concat([header(name, body.length, type), body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function pax(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (Buffer.byteLength(`${length} ${payload}`) !== length) length = Buffer.byteLength(`${length} ${payload}`);
  return Buffer.from(`${length} ${payload}`);
}

async function stagedInput(t, bytes, sentinel = true) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-archive-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, 'artifact');
  await mkdir(artifactRoot);
  await writeFile(join(artifactRoot, 'package.tgz'), bytes);
  const calls = join(root, 'tar-calls');
  const tarBin = join(root, 'tar-sentinel');
  // This stub deliberately never extracts anything, even against the old code.
  // The security expectation is that preflight rejects before ANY tar child.
  await writeFile(tarBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls.replaceAll("'", "'\\''")}'\nexit 73\n`);
  await chmod(tarBin, 0o700);
  return {
    calls,
    input: {
      artifactRoot,
      packagesRoot: join(root, 'staging'),
      packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      tarBin: sentinel ? tarBin : 'tar',
    },
  };
}

async function rejectsBeforeTar(t, bytes) {
  const { input, calls } = await stagedInput(t, bytes);
  let failure;
  try {
    const located = await stageVerifiedPackageArchive(input);
    await located.release();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'over-budget archive must be rejected');
  await assert.rejects(access(calls), { code: 'ENOENT' }, 'archive was sent to tar before bounded preflight');
  assert.equal(failure.code, 'PACKAGE_AUTHORITY_MISMATCH');
  assert.match(
    String(failure.message),
    /budget|limit/i,
    'must reject the resource claim, not a later parse/extraction failure',
  );
}

test('rejects a huge claimed regular member before any tar subprocess', async (t) => {
  await rejectsBeforeTar(t, gzipSync(Buffer.concat([header('package/huge.bin', 1024 ** 3), Buffer.alloc(1024)])));
});

test('accepts a packaged native runner within the total expanded budget', async (t) => {
  // A shipped CLI may exceed 32MiB while the complete package remains under 64MiB.
  const gzip = createGzip();
  const chunks = [];
  gzip.on('data', (chunk) => chunks.push(chunk));
  const ended = once(gzip, 'end');
  gzip.write(header('package/dist/runner', 48 * 1024 * 1024));
  const block = Buffer.alloc(64 * 1024);
  for (let i = 0; i < 768; i += 1) if (!gzip.write(block)) await once(gzip, 'drain');
  gzip.end(Buffer.alloc(1024));
  await ended;
  const { input } = await stagedInput(t, Buffer.concat(chunks));
  await preflightPluginArchive(join(input.artifactRoot, 'package.tgz'));
});

test('rejects a single member exceeding 64MiB before any tar subprocess', async (t) => {
  await rejectsBeforeTar(
    t,
    gzipSync(Buffer.concat([header('package/runner', 64 * 1024 * 1024 + 1), Buffer.alloc(1024)])),
  );
});

test('rejects excessive regular-file count before any tar subprocess', async (t) => {
  const records = Array.from({ length: 20_000 }, (_, i) => header(`package/f${i}`));
  await rejectsBeforeTar(t, gzipSync(Buffer.concat([...records, Buffer.alloc(1024)])));
});

test('bounds expanded work across individually small compressible files before tar', async (t) => {
  // Stream 128MiB of zeros into gzip; never allocate or extract a 128MiB body.
  const gzip = createGzip();
  const chunks = [];
  gzip.on('data', (chunk) => chunks.push(chunk));
  const ended = once(gzip, 'end');
  const block = Buffer.alloc(64 * 1024);
  for (let file = 0; file < 8; file += 1) {
    if (!gzip.write(header(`package/part${file}`, 16 * 1024 * 1024))) await once(gzip, 'drain');
    for (let i = 0; i < 256; i += 1) if (!gzip.write(block)) await once(gzip, 'drain');
  }
  gzip.end(Buffer.alloc(1024));
  await ended;
  await rejectsBeforeTar(t, Buffer.concat(chunks));
});

test('applies the member budget to PAX size overrides before any tar subprocess', async (t) => {
  const bytes = Buffer.concat([
    member('package/PaxHeader', pax('size', String(1024 ** 3)), 'x'),
    header('package/huge.bin'),
    Buffer.alloc(1024),
  ]);
  await rejectsBeforeTar(t, gzipSync(bytes));
});

test('bounds PAX path depth before any tar subprocess', async (t) => {
  const bytes = Buffer.concat([
    member('package/PaxHeader', pax('path', `package/${'nested/'.repeat(1024)}file`), 'x'),
    header('package/short'),
    Buffer.alloc(1024),
  ]);
  await rejectsBeforeTar(t, gzipSync(bytes));
});

test('stages a small ordinary package and retains integrity verification', async (t) => {
  const bytes = gzipSync(
    Buffer.concat([
      member('package/manifest.json', Buffer.from(JSON.stringify(manifest()))),
      member('package/dist/entrypoint.js', Buffer.from('// not executed\n')),
      Buffer.alloc(1024),
    ]),
  );
  const { input } = await stagedInput(t, bytes, false);
  const located = await stageVerifiedPackageArchive(input);
  try {
    assert.equal(located.manifest.pluginId, 'official.test-source');
    await located.verifyIntegrity();
  } finally {
    await located.release();
  }
});

for (const [label, bytes] of [
  ['symlink', Buffer.concat([header('package/link', 0, '2'), Buffer.alloc(1024)])],
  ['sparse header', Buffer.concat([header('package/sparse', 0, 'S'), Buffer.alloc(1024)])],
  [
    'PAX sparse map',
    Buffer.concat([
      member('package/PaxHeader', pax('GNU.sparse.map', '0,1'), 'x'),
      header('package/f'),
      Buffer.alloc(1024),
    ]),
  ],
  [
    'global PAX size',
    Buffer.concat([member('package/PaxHeader', pax('size', '100'), 'g'), header('package/f'), Buffer.alloc(1024)]),
  ],
  [
    'PAX traversal',
    Buffer.concat([
      member('package/PaxHeader', pax('path', 'package/../escape'), 'x'),
      header('package/f'),
      Buffer.alloc(1024),
    ]),
  ],
  [
    'GNU long path depth',
    Buffer.concat([
      member('package/LongLink', Buffer.from(`package/${'deep/'.repeat(100)}f\0`), 'L'),
      header('package/f'),
      Buffer.alloc(1024),
    ]),
  ],
  ['nonzero trailing header', Buffer.concat([header('package/f'), Buffer.alloc(1024), header('package/after')])],
  ['truncated payload', Buffer.concat([header('package/f', 100)])],
  ['bad checksum', Buffer.concat([Buffer.alloc(512, 1), Buffer.alloc(1024)])],
  ['oversized metadata', Buffer.concat([header('package/PaxHeader', 1024 * 1024, 'x'), Buffer.alloc(1024)])],
]) {
  test(`rejects ${label} before tar`, async (t) => rejectsBeforeTar(t, gzipSync(bytes)));
}

for (const kind of ['PAX', 'GNU']) {
  test(`stages a bounded ${kind} long path using platform tar`, async (t) => {
    const path = `package/${'folder/'.repeat(16)}file.txt`;
    const extension =
      kind === 'PAX'
        ? member('package/PaxHeader', Buffer.concat([pax('path', path), pax('size', '3')]), 'x')
        : member('package/LongLink', Buffer.from(`${path}\0`), 'L');
    const bytes = gzipSync(
      Buffer.concat([
        member('package/manifest.json', Buffer.from(JSON.stringify(manifest()))),
        extension,
        member('package/short', Buffer.from('abc')),
        Buffer.alloc(1024),
      ]),
    );
    const { input } = await stagedInput(t, bytes, false);
    const located = await stageVerifiedPackageArchive(input);
    try {
      await located.verifyIntegrity();
    } finally {
      await located.release();
    }
  });
}

test('rejects a cancelled request without invoking tar', async (t) => {
  const { input, calls } = await stagedInput(t, gzipSync(Buffer.alloc(1024)));
  await assert.rejects(stageVerifiedPackageArchive({ ...input, signal: AbortSignal.abort() }));
  await assert.rejects(access(calls), { code: 'ENOENT' });
});

function binaryPax(key, value) {
  const payload = Buffer.concat([Buffer.from(`${key}=`), value, Buffer.from('\n')]);
  let length = payload.length + 2;
  while (Buffer.byteLength(`${length} `) + payload.length !== length)
    length = Buffer.byteLength(`${length} `) + payload.length;
  return Buffer.concat([Buffer.from(`${length} `), payload]);
}

test('accepts bounded binary SCHILY provenance without treating it as UTF-8 path data', async (t) => {
  const bytes = gzipSync(
    Buffer.concat([
      member(
        'package/PaxHeader',
        binaryPax('SCHILY.xattr.com.apple.provenance', Buffer.from('0102007ed6f1cac4b7c3ae', 'hex')),
        'x',
      ),
      header('package/f'),
      Buffer.alloc(1024),
    ]),
  );
  const { input, calls } = await stagedInput(t, bytes);
  await preflightPluginArchive(join(input.artifactRoot, 'package.tgz'));
  await assert.rejects(access(calls), { code: 'ENOENT' });
});

test('rejects invalid UTF-8 PAX paths as a typed staging error and remains usable', async (t) => {
  const bytes = gzipSync(
    Buffer.concat([
      member('package/PaxHeader', binaryPax('path', Buffer.from([0xff])), 'x'),
      header('package/f'),
      Buffer.alloc(1024),
    ]),
  );
  await rejectsBeforeTar(t, bytes);
  const { input } = await stagedInput(t, gzipSync(Buffer.concat([header('package/ok'), Buffer.alloc(1024)])));
  await preflightPluginArchive(join(input.artifactRoot, 'package.tgz'));
});
