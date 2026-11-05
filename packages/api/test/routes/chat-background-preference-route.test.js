import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  chatBackgroundSchema as v1Background,
  chatBackgroundPreferencesSchema as v1Provider,
} from '../fixtures/chat-background-v1/schema.js';
import {
  readChatBackgroundPreferences as v1Read,
  saveChatBackgroundPreference as v1Save,
} from '../fixtures/chat-background-v1/store.js';

// This is the real config entry, so a preference helper without route registration cannot pass.
describe('owner-private chat backgrounds', () => {
  const owner = 'background-owner';
  const headers = { 'x-cat-cafe-user': owner };
  const sunset = {
    kind: 'image',
    url: '/backgrounds/sunset-clouds.jpg',
    name: '黄昏的云',
    placement: 'fill',
    opacity: { light: 0.11, dark: 0.14 },
    recommendedOpacity: { light: 0.11, dark: 0.14 },
  };
  const cafe = { ...sunset, url: '/backgrounds/cafe-night.jpg', name: 'Café 夜晚' };
  let app;
  let projectRoot;
  const threadStore = {
    get: async (id) =>
      id === 'owned' || id === 'foreign' ? { id, createdBy: id === 'owned' ? owner : 'someone-else' } : null,
  };
  const start = async () => {
    const { configRoutes } = await import('../../dist/routes/config.js');
    app = Fastify();
    await app.register(configRoutes, { projectRoot, threadStore });
    await app.ready();
  };
  const put = (body, requestHeaders = headers) =>
    app.inject({ method: 'PUT', url: '/api/config/chat-background', headers: requestHeaders, payload: body });
  const get = () => app.inject({ method: 'GET', url: '/api/config/chat-background', headers });
  beforeEach(async () => {
    process.env.DEFAULT_OWNER_USER_ID = owner;
    projectRoot = await mkdtemp(join(tmpdir(), 'chat-background-'));
    await start();
  });
  afterEach(async () => {
    await app?.close();
    delete process.env.DEFAULT_OWNER_USER_ID;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('keeps global and thread choices across API recreation, including explicit none and inheritance', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(join(projectRoot, '.cat-cafe/user-preferences.json'), JSON.stringify({ catOrder: ['sol'] }));
    const initial = await get();
    assert.equal(initial.statusCode, 200, initial.payload);
    assert.deepEqual(initial.json(), { threads: {} });
    const global = await put({ scope: 'global', background: sunset });
    assert.equal(global.statusCode, 200, global.payload);
    const thread = await put({ scope: 'thread', threadId: 'owned', background: cafe });
    assert.equal(thread.statusCode, 200, thread.payload);
    assert.deepEqual(thread.json(), { global: sunset, threads: { owned: cafe } });
    await app.close();
    await start();
    assert.deepEqual((await get()).json(), thread.json());
    const none = await put({ scope: 'thread', threadId: 'owned', background: { kind: 'none' } });
    assert.deepEqual(none.json().threads.owned, { kind: 'none' });
    const inherit = await put({ scope: 'thread', threadId: 'owned', background: null });
    assert.deepEqual(inherit.json(), { global: sunset, threads: {} });
    const disk = JSON.parse(await readFile(join(projectRoot, '.cat-cafe/user-preferences.json'), 'utf8'));
    assert.deepEqual(disk.catOrder, ['sol']);
    assert.deepEqual(disk.chatBackgrounds.global, sunset);
    assert.equal(JSON.stringify(disk).includes('expiresAt'), false);
  });

  it('rejects unauthenticated browsers, guests, foreign threads, remote images and invalid opacity without writing', async () => {
    assert.equal(
      (await put({ scope: 'global', background: sunset }, { origin: 'http://localhost:3451' })).statusCode,
      401,
    );
    assert.equal((await put({ scope: 'global', background: sunset }, { 'x-cat-cafe-user': 'guest' })).statusCode, 403);
    assert.equal((await put({ scope: 'thread', threadId: 'foreign', background: sunset })).statusCode, 404);
    assert.equal((await put({ scope: 'thread', threadId: 'missing', background: sunset })).statusCode, 404);
    for (const background of [
      { ...sunset, url: 'https://tracker.example/image.jpg' },
      { ...sunset, url: '/uploads/../secret.png' },
      { ...sunset, url: 'data:image/svg+xml,<svg/>' },
      { ...sunset, opacity: { light: 0.41, dark: 0.14 } },
      { ...sunset, placement: 'future' },
    ]) {
      const response = await put({ scope: 'global', background });
      assert.equal(response.statusCode, 400, response.payload);
    }
    assert.deepEqual((await get()).json(), { threads: {} });
  });

  it('round trips quiet defaults, readability bounds and per-mode manual intent without breaking legacy preferences', async () => {
    const background = {
      ...sunset,
      opacity: { light: 0.2, dark: 0.13 },
      recommendedOpacity: { light: 0.2, dark: 0.13 },
      readableOpacity: { light: 0.38, dark: 0.13 },
      manualOpacity: { light: true, dark: false },
    };
    const { readableOpacity, manualOpacity, ...legacyBackground } = background;
    const metadata = { readableOpacity, manualOpacity };
    const saved = await put({ scope: 'global', background: legacyBackground, metadata });
    assert.equal(saved.statusCode, 200, saved.payload);
    const threaded = await put({ scope: 'thread', threadId: 'owned', background: legacyBackground, metadata });
    assert.equal(threaded.statusCode, 200, threaded.payload);
    await app.close();
    await start();
    const snapshot = (await get()).json();
    assert.deepEqual(v1Provider.parse(snapshot), { global: legacyBackground, threads: { owned: legacyBackground } });
    const oldApiSnapshot = v1Read(projectRoot);
    assert.deepEqual(oldApiSnapshot.global, legacyBackground);
    assert.deepEqual(Object.entries(oldApiSnapshot.threads), [['owned', legacyBackground]]);
    assert.deepEqual(snapshot.metadata.global, { background: legacyBackground, ...metadata });
    assert.deepEqual(snapshot.metadata.threads.owned, snapshot.metadata.global);
    const disk = JSON.parse(await readFile(join(projectRoot, '.cat-cafe/user-preferences.json'), 'utf8'));
    assert.deepEqual(v1Background.parse(disk.chatBackgrounds.global), legacyBackground);
    assert.deepEqual(v1Background.parse(disk.chatBackgrounds.threads.owned), legacyBackground);
    for (const invalid of [
      { ...metadata, readableOpacity: { light: 0.41, dark: 0.13 } },
      { ...metadata, manualOpacity: { light: 'yes' } },
    ])
      assert.equal((await put({ scope: 'global', background: legacyBackground, metadata: invalid })).statusCode, 400);
    assert.deepEqual((await get()).json(), snapshot);
    // An old client talking to the current API only replaces its own scope.
    await put({ scope: 'global', background: cafe });
    const changedByOldClient = (await get()).json();
    assert.deepEqual(changedByOldClient.global, cafe);
    assert.equal(
      changedByOldClient.metadata.global,
      undefined,
      'stale bound metadata must not apply to an old-client update',
    );
    assert.deepEqual(changedByOldClient.metadata.threads.owned, snapshot.metadata.threads.owned);
    const legacy = await put({ scope: 'global', background: sunset });
    assert.equal(legacy.statusCode, 200, legacy.payload);
    assert.deepEqual(legacy.json().global, sunset);
  });

  it('does not overwrite corrupt or future sibling preferences', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    const path = join(projectRoot, '.cat-cafe/user-preferences.json');
    await writeFile(path, '{broken');
    assert.equal((await put({ scope: 'global', background: sunset })).statusCode, 500);
    assert.equal(await readFile(path, 'utf8'), '{broken');
    await writeFile(
      path,
      JSON.stringify({ chatBackgrounds: { future: true, threads: { later: { kind: 'future' } } } }),
    );
    const saved = await put({ scope: 'global', background: sunset });
    assert.equal(saved.statusCode, 200, saved.payload);
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(disk.chatBackgrounds.future, true);
    assert.deepEqual(disk.chatBackgrounds.threads.later, { kind: 'future' });
  });

  it('preserves bound intent across unrelated canonical preference writes but not opaque legacy rewrites', async () => {
    const metadata = { readableOpacity: { light: 0.3, dark: 0.2 }, manualOpacity: { light: true } };
    await put({ scope: 'global', background: sunset, metadata });
    await put({ scope: 'thread', threadId: 'owned', background: cafe, metadata });
    const before = (await get()).json();
    const { updateUserPreferences } = await import('../../dist/config/user-preferences-store.js');
    updateUserPreferences(projectRoot, (current) => ({ ...current, catOrder: ['sol'] }));
    assert.deepEqual((await get()).json(), before);
    // A truly old binary cannot attest which scopes changed during an unobserved ABA.
    // Its whole-file rewrite invalidates sidecar state; the v1 choices themselves remain intact.
    const { updateUserPreferences: legacyUpdate } = await import('../fixtures/chat-background-v1/disk-store.js');
    legacyUpdate(projectRoot, (current) => ({ ...current, catOrder: ['kimi'] }));
    const after = (await get()).json();
    assert.equal(after.metadata, undefined);
    assert.deepEqual(after.global, before.global);
    assert.deepEqual(after.threads, before.threads);
    assert.deepEqual(
      JSON.parse(await readFile(join(projectRoot, '.cat-cafe/user-preferences.json'), 'utf8')).catOrder,
      ['kimi'],
    );
    updateUserPreferences(projectRoot, (current) => ({ ...current, catOrder: ['sol'] }));
    assert.equal((await get()).json().metadata, undefined, 'a later canonical write cannot re-attest old opaque state');
  });

  it('keeps the old bytes and metadata seal when an atomic write cannot serialize its next state', async () => {
    const metadata = { manualOpacity: { light: true } };
    await put({ scope: 'global', background: sunset, metadata });
    const file = join(projectRoot, '.cat-cafe/user-preferences.json');
    const before = await readFile(file, 'utf8');
    const { updateUserPreferences } = await import('../../dist/config/user-preferences-store.js');
    const circular = {};
    circular.self = circular;
    assert.throws(() => updateUserPreferences(projectRoot, (current) => ({ ...current, circular })));
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(
      (await readdir(join(projectRoot, '.cat-cafe'))).some((name) => name.endsWith('.tmp')),
      false,
    );
    assert.deepEqual((await get()).json().metadata.global.manualOpacity, metadata.manualOpacity);
  });

  for (const scope of ['global', 'thread']) {
    for (const intermediate of [{ kind: 'none' }, null, cafe]) {
      for (const observeIntermediate of [false, true]) {
        it(`never revives metadata after legacy ${scope} A→${intermediate?.kind ?? 'inherit'}→A (GET=${observeIntermediate})`, async () => {
          const target = { scope, ...(scope === 'thread' ? { threadId: 'owned' } : {}) };
          const metadata = { readableOpacity: { light: 0.3, dark: 0.2 }, manualOpacity: { light: true } };
          assert.equal((await put({ ...target, background: sunset, metadata })).statusCode, 200);
          v1Save(projectRoot, { ...target, background: intermediate });
          if (observeIntermediate) {
            const mid = (await get()).json();
            assert.equal(scope === 'global' ? mid.metadata?.global : mid.metadata?.threads?.owned, undefined);
          }
          v1Save(projectRoot, { ...target, background: sunset });
          await app.close();
          await start();
          const after = (await get()).json();
          assert.deepEqual(scope === 'global' ? after.global : after.threads.owned, sunset);
          assert.equal(scope === 'global' ? after.metadata?.global : after.metadata?.threads?.owned, undefined);
        });
      }
    }
  }

  for (const invalid of [null, [], 42, 'damaged']) {
    for (const field of ['chatBackgrounds', 'threads']) {
      it(`refuses a malformed ${field} container (${JSON.stringify(invalid)}) without changing any bytes`, async () => {
        await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
        const path = join(projectRoot, '.cat-cafe/user-preferences.json');
        const bytes = JSON.stringify({
          catOrder: ['sol'],
          chatBackgrounds: field === 'chatBackgrounds' ? invalid : { global: sunset, threads: invalid },
        });
        await writeFile(path, bytes);
        assert.equal((await get()).statusCode, 500);
        for (const input of [
          { scope: 'global', background: cafe },
          { scope: 'thread', threadId: 'owned', background: { kind: 'none' } },
        ]) {
          assert.equal((await put(input)).statusCode, 500);
          assert.equal(await readFile(path, 'utf8'), bytes);
        }
      });
    }
  }
});
