import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function closeStores(services) {
  const stores = new Set([services?.store, services?.globalStore, ...(services?.collectionStores?.values() ?? [])]);
  for (const store of stores) store?.close?.();
}

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) delete process.env[name];
  else process.env[name] = previousValue;
}

test('global knowledge defaults to the configured data root', async () => {
  const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'f289-memory-data-root-'));
  const homeDir = join(fixtureRoot, 'home');
  const dataDir = join(fixtureRoot, 'isolated-data');
  const previousHome = process.env.HOME;
  const previousGlobalDb = process.env.GLOBAL_KNOWLEDGE_DB;
  let services;

  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  delete process.env.GLOBAL_KNOWLEDGE_DB;

  try {
    services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: join(fixtureRoot, 'docs'),
      markersDir: join(fixtureRoot, 'markers'),
      dataDir,
      includeRosterEntitySeeds: false,
    });

    const isolatedGlobalDb = join(dataDir, 'global_knowledge.sqlite');
    const legacyHomeGlobalDb = join(homeDir, '.cat-cafe', 'global_knowledge.sqlite');

    assert.equal(existsSync(isolatedGlobalDb), true, 'global knowledge must follow the configured data root');
    assert.equal(existsSync(legacyHomeGlobalDb), false, 'isolated startup must not open the user-home database');
    assert.equal(services.catalog?.get('global:methods')?.root, dataDir);
  } finally {
    closeStores(services);
    restoreEnv('HOME', previousHome);
    restoreEnv('GLOBAL_KNOWLEDGE_DB', previousGlobalDb);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('explicit global knowledge override wins over the configured data root', async () => {
  const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'f289-memory-global-override-'));
  const dataDir = join(fixtureRoot, 'isolated-data');
  const explicitGlobalDb = join(fixtureRoot, 'explicit', 'global.sqlite');
  const previousGlobalDb = process.env.GLOBAL_KNOWLEDGE_DB;
  let services;

  process.env.GLOBAL_KNOWLEDGE_DB = explicitGlobalDb;

  try {
    services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: join(fixtureRoot, 'docs'),
      markersDir: join(fixtureRoot, 'markers'),
      dataDir,
      includeRosterEntitySeeds: false,
    });

    assert.equal(existsSync(explicitGlobalDb), true, 'explicit global DB override must remain authoritative');
    assert.equal(existsSync(join(dataDir, 'global_knowledge.sqlite')), false);
    assert.equal(services.catalog?.get('global:methods')?.root, join(fixtureRoot, 'explicit'));
  } finally {
    closeStores(services);
    restoreEnv('GLOBAL_KNOWLEDGE_DB', previousGlobalDb);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
