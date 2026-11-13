import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { parse, stringify } from 'yaml';
import { readZip, writeZip } from '../../src/domains/console-themes/zip.js';
import { configRoutes } from '../../src/routes/config.js';

const url = '/api/console-themes/packages';
const owner = 'theme-package-owner';
const headers = { 'x-cat-cafe-user': owner };
const theme = {
  id: 'night',
  name: '夜色',
  version: '1',
  contractVersion: '0.4.0',
  uses: ['cards'],
  pdl: { palette: { ink: '#123456' }, views: {} },
};
const manifest = (value: unknown) => Buffer.from(stringify(value));
const files = () => ({
  'theme.yaml': manifest(theme),
  'components/cards/z.js': Buffer.from('register("last");'),
  'components/cards/a.js': Buffer.from('register("first");'),
  'components/cards/style.css': Buffer.from('.card {}'),
  'components/unused/other.js': Buffer.from('unused'),
  'i18n/zh/z.json': Buffer.from('{"label":"最后","second":2}'),
  'i18n/zh/a.json': Buffer.from('{"label":"最初","first":1}'),
  'i18n/en/text.json': Buffer.from('{"label":"Night"}'),
  'assets/moon.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  'assets/text.woff2': Buffer.from('font bytes'),
});

// A stored, data-descriptor ZIP independent of the production writer.
function storedZip(name: string, data: Buffer): Buffer {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 6);
  local.writeUInt16LE(filename.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50);
  descriptor.writeUInt32LE(crc32(data), 4);
  descriptor.writeUInt32LE(data.length, 8);
  descriptor.writeUInt32LE(data.length, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 8);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length + descriptor.length, 16);
  return Buffer.concat([local, filename, data, descriptor, central, filename, end]);
}

describe('owner console theme packages', () => {
  let app: FastifyInstance;
  let projectRoot: string;
  let previousOwner: string | undefined;
  const upload = (zip: Buffer) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/zip' },
      payload: zip,
    });
  const install = (entries = files()) => upload(writeZip(entries));
  const get = (path = '') => app.inject({ method: 'GET', url: url + path, headers });
  async function reject(zip: Buffer, reason: RegExp) {
    const result = await upload(zip);
    assert.equal(result.statusCode, 400, result.payload);
    assert.match(result.json().error, reason);
    assert.deepEqual((await get()).json(), { packages: [] });
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'console-theme-packages-'));
    previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = owner;
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('installs, lists, reads, serves assets and round trips the original package through export', async () => {
    assert.deepEqual((await get()).json(), { packages: [] });
    const result = await install();
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(result.json(), { id: 'night' });
    assert.deepEqual((await get()).json(), {
      packages: [{ id: 'night', name: '夜色', version: '1', contractVersion: '0.4.0' }],
    });
    const original = (await get('/night')).json();
    assert.deepEqual(original, {
      ...theme,
      components: { cards: { js: ['register("first");', 'register("last");'], css: ['.card {}'] } },
      i18n: { zh: { label: '最后', first: 1, second: 2 }, en: { label: 'Night' } },
      assets: {
        moon: { type: 'image', mime: 'image/png', src: `${url}/night/assets/moon.png` },
        text: { type: 'font', mime: 'font/woff2', src: `${url}/night/assets/text.woff2` },
      },
    });
    for (const file of ['moon.png', 'text.woff2']) {
      const asset = await get(`/night/assets/${file}`);
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.headers['content-type'], file.endsWith('png') ? 'image/png' : 'font/woff2');
      assert.deepEqual(asset.rawPayload, files()[`assets/${file}` as keyof ReturnType<typeof files>]);
    }
    const exported = await get('/night/export');
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.headers['content-type'], 'application/zip');
    assert.equal(exported.headers['content-disposition'], 'attachment; filename="night.theme.zip"');
    assert.deepEqual({ ...readZip(exported.rawPayload) }, files());
    await app.inject({ method: 'DELETE', url: `${url}/night`, headers });
    assert.deepEqual((await upload(exported.rawPayload)).json(), { id: 'night' });
    assert.deepEqual((await get('/night')).json(), original);
    await app.close();
    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    assert.deepEqual((await get('/night')).json(), original);
  });

  it('updates the same id with a directory replacement and deletes the package', async () => {
    await install();
    assert.deepEqual((await install({ 'theme.yaml': manifest({ ...theme, version: '2', uses: [] }) })).json(), {
      id: 'night',
    });
    const updated = (await get('/night')).json();
    assert.equal(updated.version, '2');
    assert.deepEqual(updated.assets, {});
    assert.deepEqual(updated.components, {});
    assert.equal((await get()).json().packages.length, 1);
    assert.deepEqual(await readdir(join(projectRoot, '.cat-cafe/console-themes')), ['night']);
    assert.equal((await app.inject({ method: 'DELETE', url: `${url}/night`, headers })).statusCode, 204);
    assert.deepEqual((await get()).json(), { packages: [] });
    for (const path of ['/night', '/night/assets/moon.png', '/night/export'])
      assert.equal((await get(path)).statusCode, 404);
  });

  it('resolves used components from another installed package, preferring its own files', async () => {
    await install();
    await install({ 'theme.yaml': manifest({ ...theme, id: 'shared' }) });
    assert.deepEqual((await get('/shared')).json().components, (await get('/night')).json().components);
    const own = { 'theme.yaml': manifest({ ...theme, id: 'shared' }), 'components/cards/own.js': Buffer.from('own') };
    assert.equal((await install(own)).statusCode, 200);
    assert.deepEqual((await get('/shared')).json().components, { cards: { js: ['own'], css: [] } });
  });

  it('rejects an update relying on components removed from that same package, preserving the installed version', async () => {
    await install();
    const result = await install({ 'theme.yaml': manifest({ ...theme, version: '2' }) });
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /Missing used component/);
    assert.equal((await get('/night')).json().version, '1');
  });

  it('returns custom themes without storage and exports them as a theme.yaml zip', async () => {
    const custom = {
      ...theme,
      id: 'custom',
      extends: 'night',
      pdl: { doc: { tree: [] }, base: { tree: [] }, palette: {} },
    };
    const result = await install({ 'theme.yaml': manifest(custom) });
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(result.json(), { custom });
    assert.deepEqual((await get()).json(), { packages: [] });
    await assert.rejects(readdir(join(projectRoot, '.cat-cafe/console-themes')), { code: 'ENOENT' });
    const exported = await app.inject({
      method: 'POST',
      url: '/api/console-themes/export',
      headers,
      payload: { theme: custom },
    });
    assert.equal(exported.statusCode, 200, exported.payload);
    assert.equal(exported.headers['content-type'], 'application/zip');
    assert.equal(exported.headers['content-disposition'], 'attachment; filename="custom.theme.zip"');
    const entries = readZip(exported.rawPayload);
    assert.deepEqual(Object.keys(entries), ['theme.yaml']);
    assert.deepEqual(parse(entries['theme.yaml'].toString()), custom);
    assert.deepEqual((await upload(exported.rawPayload)).json(), { custom });
  });

  it('reads stored archives with data descriptors and explicit directory entries', async () => {
    assert.equal((await upload(storedZip('theme.yaml', manifest({ ...theme, uses: [] })))).statusCode, 200);
    const result = await install({
      ...files(),
      'components/': Buffer.alloc(0),
      'components/cards/': Buffer.alloc(0),
      'i18n/': Buffer.alloc(0),
      'i18n/zh/': Buffer.alloc(0),
      'assets/': Buffer.alloc(0),
    });
    assert.equal(result.statusCode, 200, result.payload);
  });

  it('installs a folder compressed by Finder or Explorer (one top folder, OS files ignored)', async () => {
    const inner = files();
    const zip = writeZip({
      ...Object.fromEntries(Object.entries(inner).map(([name, data]) => [`night/${name}`, data])),
      'night/': Buffer.alloc(0),
      'night/.DS_Store': Buffer.from('x'),
      '__MACOSX/night/._theme.yaml': Buffer.from('x'),
      'night/assets/Thumbs.db': Buffer.from('x'),
    });
    const result = await upload(zip);
    assert.equal(result.statusCode, 200, result.payload);
  });
  it('rejects files outside the one top folder', async () => {
    const inner = files();
    await reject(
      writeZip({
        ...Object.fromEntries(Object.entries(inner).map(([name, data]) => [`night/${name}`, data])),
        'other/theme.yaml': Buffer.from('x'),
      }),
      /Invalid zip path/,
    );
  });
  for (const path of [
    '../theme.yaml',
    '/theme.yaml',
    'C:/theme.yaml',
    'assets/../escape.png',
    'assets\\escape.png',
    'other/file.js',
    'components/code.js',
    'components/cards/code.ts',
    'i18n/en/text.yaml',
    'assets/file.exe',
    'assets/sub/file.png',
    'assets/./file.png',
    'assets//file.png',
    'assets/null\0.png',
  ]) {
    it(`rejects forbidden zip path ${JSON.stringify(path)}`, async () => {
      await reject(writeZip({ ...files(), [path]: Buffer.from('x') }), /Invalid zip path/);
    });
  }
  it('rejects more than 2000 entries', async () => {
    const entries: Record<string, Buffer> = { 'theme.yaml': manifest({ ...theme, uses: [] }) };
    for (let i = 0; i < 2000; i++) entries[`assets/${i}.png`] = Buffer.alloc(0);
    await reject(writeZip(entries), /Too many zip entries/);
  });
  it('rejects a file over 8 MB', async () => {
    await reject(writeZip({ ...files(), 'assets/large.png': Buffer.alloc(8 * 1024 * 1024 + 1) }), /exceeds 8 MB/);
  });
  it('rejects total uncompressed content over 64 MB', async () => {
    const entries: Record<string, Buffer> = { 'theme.yaml': manifest({ ...theme, uses: [] }) };
    for (let i = 0; i < 8; i++) entries[`assets/${i}.png`] = Buffer.alloc(8 * 1024 * 1024);
    await reject(writeZip(entries), /exceeds 64 MB/);
  });
  it('enforces the 32 MB upload limit', async () => {
    assert.equal((await upload(Buffer.alloc(32 * 1024 * 1024 + 1))).statusCode, 413);
  });
  for (const id of ['Bad', '../escape', '', 'a'.repeat(65), '-bad']) {
    it(`rejects invalid theme id ${JSON.stringify(id)}`, async () => {
      await reject(writeZip({ 'theme.yaml': manifest({ ...theme, id, uses: [] }) }), /Invalid theme/);
    });
  }
  for (const pdl of [null, [], 'invalid']) {
    it(`rejects non-object pdl ${JSON.stringify(pdl)}`, async () => {
      await reject(writeZip({ 'theme.yaml': manifest({ ...theme, uses: [], pdl }) }), /Invalid theme/);
    });
  }
  it('rejects missing identity fields and malformed uses', async () => {
    for (const field of ['name', 'version', 'contractVersion']) {
      const value: Record<string, unknown> = { ...theme, uses: [] };
      delete value[field];
      await reject(writeZip({ 'theme.yaml': manifest(value) }), /Invalid theme/);
    }
    await reject(writeZip({ 'theme.yaml': manifest({ ...theme, uses: 'cards' }) }), /Invalid theme/);
  });
  it('rejects a missing used component package', async () => {
    await reject(writeZip({ 'theme.yaml': manifest(theme) }), /Missing used component/);
  });
  it('rejects a missing manifest', async () => {
    await reject(writeZip({}), /Missing theme.yaml/);
  });
  it('rejects invalid YAML and invalid i18n JSON at import', async () => {
    await reject(writeZip({ 'theme.yaml': Buffer.from('pdl: [') }), /Invalid theme.yaml/);
    await reject(writeZip({ ...files(), 'i18n/en/text.json': Buffer.from('{') }), /Invalid i18n JSON/);
    await reject(writeZip({ ...files(), 'i18n/en/text.json': Buffer.from('[]') }), /Invalid i18n JSON/);
  });
  it('rejects invalid custom exports and non-zip imports', async () => {
    for (const payload of [{}, { theme }, { theme: { ...theme, id: '../escape', pdl: { doc: {} } } }]) {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/console-themes/export', headers, payload })).statusCode,
        400,
      );
    }
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { theme } })).statusCode, 400);
  });
  it('rejects invalid route ids and asset paths, never serving another package directory', async () => {
    await install();
    for (const path of [
      '/Bad',
      '/night/assets/..%2Ftheme.yaml',
      '/night/assets/..%5Ctheme.yaml',
      '/night/assets/theme.yaml',
    ]) {
      assert.equal((await get(path)).statusCode, 400, path);
    }
    assert.equal((await get('/missing/assets/moon.png')).statusCode, 404);
  });
  it('rejects malformed, unsupported, corrupt and deceptively sized zip entries', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not a zip'), writeZip(files()).subarray(0, -1)]) {
      await reject(bytes, /Invalid zip/);
    }
    for (const change of ['method', 'encrypted', 'crc', 'size', 'offset', 'length', 'bomb']) {
      const zip = writeZip({ 'theme.yaml': manifest({ ...theme, uses: [] }) });
      const central = zip.readUInt32LE(zip.length - 6);
      if (change === 'method') zip.writeUInt16LE(99, central + 10);
      if (change === 'encrypted') zip.writeUInt16LE(1, central + 8);
      if (change === 'crc') zip.writeUInt32LE(0, central + 16);
      if (change === 'size') zip.writeUInt32LE(1, central + 24);
      if (change === 'offset') zip.writeUInt32LE(0xffffffff, central + 42);
      if (change === 'length') zip.writeUInt16LE(65535, central + 28);
      if (change === 'bomb') {
        const large = writeZip({ 'assets/large.png': Buffer.alloc(8 * 1024 * 1024 + 1) });
        large.writeUInt32LE(1, large.readUInt32LE(large.length - 6) + 24);
        await reject(large, /Invalid zip/);
      } else await reject(zip, /Invalid zip|Unsupported zip compression/);
    }
  });

  it('requires owner identity on every route before parsing the body', async () => {
    await install();
    for (const identity of [undefined, 'someone-else']) {
      for (const [method, path] of [
        ['POST', url],
        ['GET', url],
        ['GET', `${url}/night`],
        ['GET', `${url}/night/assets/moon.png`],
        ['DELETE', `${url}/night`],
        ['GET', `${url}/night/export`],
        ['POST', '/api/console-themes/export'],
      ] as const) {
        const result = await app.inject({
          method,
          url: path,
          headers: identity ? { 'x-cat-cafe-user': identity } : {},
        });
        assert.equal(result.statusCode, identity ? 403 : 401, `${method} ${path}: ${result.payload}`);
        assert.deepEqual(result.json(), { error: 'Owner identity required' });
      }
    }
    assert.equal((await get('/night')).statusCode, 200);
  });
  it('uses the existing local single-user owner gate behavior', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    assert.equal(
      (await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': 'local-user' } })).statusCode,
      200,
    );
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  });
});
