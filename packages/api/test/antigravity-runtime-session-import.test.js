import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

async function loadModules() {
  const importer = await import(
    '../dist/domains/cats/services/agents/providers/antigravity/antigravity-runtime-session-import.js'
  );
  const store = await import('../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js');
  return { ...importer, ...store };
}

function withTempJson(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-f211-import-'));
  const file = join(dir, 'antigravity-sessions.json');
  writeFileSync(file, content);
  return Promise.resolve()
    .then(() => fn(file))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sessionRecord(overrides = {}) {
  return {
    id: 'session-1',
    cliSessionId: 'cascade-1',
    threadId: 'thread-1',
    catId: 'antig-opus',
    userId: 'user-1',
    seq: 0,
    status: 'active',
    messageCount: 0,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function sessionChainStoreFor(recordsByCli) {
  return {
    async getByCliSessionId(cliSessionId) {
      return recordsByCli.get(cliSessionId) ?? null;
    },
  };
}

describe('Antigravity legacy runtime-session import', () => {
  test('imports threadId:catId entries through existing SessionRecord ids', async () => {
    const { RuntimeSessionStore, importLegacyAntigravitySessions } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    const sessionChainStore = sessionChainStoreFor(new Map([['cascade-1', sessionRecord()]]));

    await withTempJson(JSON.stringify({ 'thread-1:antig-opus': 'cascade-1' }), async (file) => {
      const result = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore,
        sessionChainStore,
      });

      assert.equal(result.imported.length, 1);
      assert.equal(result.diagnostics.length, 0);
      const imported = await runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
      assert.equal(imported.sessionId, 'session-1');
      assert.equal(imported.threadId, 'thread-1');
      assert.equal(imported.catId, 'antig-opus');
      assert.equal(imported.userId, 'user-1');
      assert.equal(imported.surface, 'cat-cafe-dispatch');
      assert.equal(imported.identityHistory[0].source, 'legacy_json_import');
      assert.equal(imported.sessionId.startsWith('legacy:'), false);
    });
  });

  test('imports thread-only legacy keys only with an explicit fallback cat id', async () => {
    const { RuntimeSessionStore, importLegacyAntigravitySessions } = await loadModules();
    const sessionChainStore = sessionChainStoreFor(
      new Map([
        [
          'cascade-legacy',
          sessionRecord({ id: 'session-legacy', cliSessionId: 'cascade-legacy', threadId: 'thread-legacy' }),
        ],
      ]),
    );

    await withTempJson(JSON.stringify({ 'thread-legacy': 'cascade-legacy' }), async (file) => {
      const skippedStore = new RuntimeSessionStore();
      const skipped = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore: skippedStore,
        sessionChainStore,
      });
      assert.equal(skipped.imported.length, 0);
      assert.equal(skipped.diagnostics[0].code, 'missing_cat_id');

      const importedStore = new RuntimeSessionStore();
      const imported = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore: importedStore,
        sessionChainStore,
        fallbackCatId: 'antig-opus',
      });
      assert.equal(imported.imported.length, 1);
      assert.equal(
        (await importedStore.getByRuntimeSession('antigravity-desktop', 'cascade-legacy')).sessionId,
        'session-legacy',
      );
    });
  });

  test('skips entries that cannot resolve an existing host SessionRecord', async () => {
    const { RuntimeSessionStore, importLegacyAntigravitySessions } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();

    await withTempJson(JSON.stringify({ 'thread-1:antig-opus': 'missing-cascade' }), async (file) => {
      const result = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore,
        sessionChainStore: sessionChainStoreFor(new Map()),
      });

      assert.equal(result.imported.length, 0);
      assert.equal(result.diagnostics[0].code, 'missing_host_session');
      assert.equal(await runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'missing-cascade'), null);
    });
  });

  test('skips entries when the legacy key or fallback identity disagrees with the host SessionRecord', async () => {
    const { RuntimeSessionStore, importLegacyAntigravitySessions } = await loadModules();
    const sessionChainStore = sessionChainStoreFor(
      new Map([
        [
          'cascade-1',
          sessionRecord({
            threadId: 'thread-1',
            catId: 'opus-47',
          }),
        ],
      ]),
    );

    await withTempJson(JSON.stringify({ 'thread-1:antig-opus': 'cascade-1' }), async (file) => {
      const runtimeSessionStore = new RuntimeSessionStore();
      const result = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore,
        sessionChainStore,
      });

      assert.equal(result.imported.length, 0);
      assert.equal(result.diagnostics[0].code, 'host_session_identity_mismatch');
      assert.equal(await runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1'), null);
    });

    await withTempJson(JSON.stringify({ 'thread-1': 'cascade-1' }), async (file) => {
      const runtimeSessionStore = new RuntimeSessionStore();
      const result = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore,
        sessionChainStore,
        fallbackCatId: 'antig-opus',
      });

      assert.equal(result.imported.length, 0);
      assert.equal(result.diagnostics[0].code, 'host_session_identity_mismatch');
      assert.equal(await runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1'), null);
    });
  });

  test('corrupt JSON emits a diagnostic and preserves the source file', async () => {
    const { RuntimeSessionStore, importLegacyAntigravitySessions, readLegacyAntigravitySessionMap } =
      await loadModules();

    await withTempJson('{not-json', async (file) => {
      const parsed = readLegacyAntigravitySessionMap(file);
      assert.deepEqual(parsed.entries, []);
      assert.equal(parsed.diagnostics[0].code, 'invalid_json');

      const result = await importLegacyAntigravitySessions({
        path: file,
        runtimeSessionStore: new RuntimeSessionStore(),
        sessionChainStore: sessionChainStoreFor(new Map()),
      });
      assert.equal(result.imported.length, 0);
      assert.equal(result.diagnostics[0].code, 'invalid_json');
      assert.equal(readFileSync(file, 'utf8'), '{not-json');
    });
  });

  test('import is idempotent for the same runtime tuple', async () => {
    const { RuntimeSessionStore, importLegacyAntigravitySessions } = await loadModules();
    const runtimeSessionStore = new RuntimeSessionStore();
    const sessionChainStore = sessionChainStoreFor(new Map([['cascade-1', sessionRecord()]]));

    await withTempJson(JSON.stringify({ 'thread-1:antig-opus': 'cascade-1' }), async (file) => {
      await importLegacyAntigravitySessions({ path: file, runtimeSessionStore, sessionChainStore });
      await importLegacyAntigravitySessions({ path: file, runtimeSessionStore, sessionChainStore });

      const imported = await runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
      assert.equal(imported.sessionId, 'session-1');
      assert.deepEqual(
        (await runtimeSessionStore.listByLifecycleState('active')).map((entry) => entry.sessionId),
        ['session-1'],
      );
    });
  });

  test('importer is read-only with respect to the legacy JSON file and Bridge session map', () => {
    const source = readFileSync(
      new URL(
        '../src/domains/cats/services/agents/providers/antigravity/antigravity-runtime-session-import.ts',
        import.meta.url,
      ),
      'utf8',
    );
    assert.doesNotMatch(source, /writeFileSync|persistSessionMap/);
  });
});
