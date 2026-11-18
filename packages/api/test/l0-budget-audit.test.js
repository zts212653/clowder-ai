import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { encodingForModel } from 'js-tiktoken';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const headers = { 'x-cat-cafe-user': 'fixture-owner' };

test('live member audit counts the captured runtime prompt and notices roster growth without exposing source data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'l0-budget-audit-'));
  const envKeys = ['CAT_TEMPLATE_PATH', 'CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_DATA_DIR', 'CAT_CAFE_GLOBAL_CONFIG_ROOT'];
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const restoreAuth = isolateAccountAuthEnvironment();
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    for (const key of envKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    catRegistry.reset();
    restoreAuth();
    rmSync(dir, { recursive: true, force: true });
  });
  const template = JSON.parse(readFileSync(join(root, 'cat-template.json'), 'utf8'));
  const breed = template.breeds.find((entry) => entry.id === 'maine-coon');
  for (let index = 0; index < 4; index++) {
    breed.variants.push({
      ...breed.variants[0],
      id: `budget-${index}`,
      catId: `budget-${index}`,
      mentionPatterns: [`@budget-${index}`],
      caution: `synthetic routing note ${index}`,
    });
  }
  // A fake credential makes accidental serialization observable without real secrets.
  template.accounts = { synthetic: { token: 'fixture-secret-do-not-return' } };
  mkdirSync(join(dir, '.cat-cafe'), { recursive: true });
  writeFileSync(join(dir, 'cat-template.json'), JSON.stringify(template));
  const catalogPath = join(dir, '.cat-cafe/cat-catalog.json');
  const legacyCatalog = structuredClone(template);
  const legacyVariant = legacyCatalog.breeds[0].variants[0];
  legacyVariant.ocProviderName = 'fixture-legacy-provider';
  delete legacyVariant.provider;
  writeFileSync(catalogPath, JSON.stringify(legacyCatalog));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  process.env.CAT_TEMPLATE_PATH = join(dir, 'cat-template.json');
  process.env.CAT_CAFE_CONFIG_ROOT = dir;
  process.env.CAT_CAFE_DATA_DIR = dir;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = dir;
  process.chdir(dir);
  const { loadResolvedCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const { readCatCatalogRaw } = await import('../dist/config/cat-catalog-store.js');
  assert.notEqual(
    readCatCatalogRaw(dir, { persistMigrations: false }),
    readFileSync(catalogPath, 'utf8'),
    'the fixture must actually require a catalog migration',
  );
  const { captureInvocationL0Input } = await import(
    '../dist/domains/cats/services/agents/providers/l0-input-capture.js'
  );
  const publish = () => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(
      toAllCatConfigs(loadResolvedCatConfig(undefined, { persistMigrations: false })),
    ))
      catRegistry.register(id, config);
  };
  publish();
  const app = (await import('fastify')).default();
  await app.register((await import('../dist/routes/cats.js')).catsRoutes);
  t.after(() => app.close());
  const anonymous = await app.inject({ method: 'GET', url: '/api/cats/l0-budget' });
  assert.equal(anonymous.statusCode, 401);
  const beforeFile = hash(readFileSync(catalogPath));
  const missingPath = `${catalogPath}.missing-test`;
  renameSync(catalogPath, missingPath);
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/cats/l0-budget', headers });
    assert.equal(missing.statusCode, 503, 'a missing runtime catalog must not silently become the template');
    assert.equal(existsSync(catalogPath), false, 'the route must not recreate a missing catalog');
    const missingCli = spawnSync(process.execPath, [join(root, 'scripts/audit-l0-budget.mjs'), '--config-root', dir], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.notEqual(missingCli.status, 0);
    assert.equal(missingCli.stdout, '');
    assert.equal(existsSync(catalogPath), false, 'the CLI must not recreate a missing catalog');
  } finally {
    renameSync(missingPath, catalogPath);
  }
  const response = await app.inject({ method: 'GET', url: '/api/cats/l0-budget', headers });
  assert.equal(response.statusCode, 200, response.payload);
  assert.doesNotMatch(response.payload, /fixture-secret-do-not-return/);
  assert.equal(hash(readFileSync(catalogPath)), beforeFile, 'the audit must never persist catalog migrations');
  const budget = response.json();
  const { auditL0Budget } = await import('../dist/domains/cats/services/context/l0-budget-audit.js');
  let otherWorkRan = false;
  const pendingAudit = auditL0Budget({ projectRoot: dir, userId: 'fixture-owner' });
  setImmediate(() => {
    otherWorkRan = true;
  });
  await pendingAudit;
  assert.ok(otherWorkRan, 'a roster audit must yield so other API work can run');
  const changingAudit = auditL0Budget({ projectRoot: dir, userId: 'fixture-owner' });
  catRegistry.reset();
  await assert.rejects(changingAudit, /registry changed/);
  publish();
  const counted = budget.members.find((member) => member.catId === 'codex');
  const captured = captureInvocationL0Input({
    catId: 'codex',
    catConfig: catRegistry.getOrThrow('codex').config,
    userId: 'fixture-owner',
    readOnlyCatalog: true,
  });
  assert.equal(counted.tokens, encodingForModel('gpt-4o').encode(renderFrozenL0Input(captured), [], []).length);
  const cli = spawnSync(
    process.execPath,
    [join(root, 'scripts/audit-l0-budget.mjs'), '--config-root', dir, '--empty-profile'],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.doesNotMatch(cli.stdout + cli.stderr, /fixture-secret-do-not-return/);
  const cliBudget = JSON.parse(cli.stdout);
  assert.equal(cliBudget.profile, 'empty');
  assert.equal(cliBudget.configRoot, dir);
  assert.equal(cliBudget.memberCount, cliBudget.members.length);
  assert.equal(cliBudget.members.find((member) => member.catId === 'codex').tokens, counted.tokens);
  assert.equal(hash(readFileSync(catalogPath)), beforeFile, 'the CLI must not change the catalog');
  const listed = await app.inject({ method: 'GET', url: '/api/cats', headers });
  assert.equal(listed.statusCode, 200, listed.payload);
  const edited = listed.json().cats.find((member) => member.id === 'budget-0');
  const save = await app.inject({
    method: 'PATCH',
    url: '/api/cats/budget-0',
    headers,
    payload: {
      expectedRevision: edited.configurationRevision,
      caution: 'Longer synthetic routing instruction '.repeat(20),
    },
  });
  assert.equal(save.statusCode, 200, save.payload);
  const savedAudit = await app.inject({ method: 'GET', url: '/api/cats/l0-budget', headers });
  assert.equal(savedAudit.statusCode, 200, savedAudit.payload);
  const before = savedAudit.json().members.find((member) => member.catId === 'codex').tokens;
  assert.ok(before > counted.tokens, 'saving a longer member note must update the live audit');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const variants = catalog.breeds.find((entry) => entry.id === 'maine-coon').variants;
  variants.push({
    ...variants[0],
    id: 'budget-new',
    catId: 'budget-new',
    mentionPatterns: ['@budget-new'],
    caution: 'a newly added synthetic roster note',
  });
  writeFileSync(catalogPath, JSON.stringify(catalog));
  publish();
  const after = await app.inject({ method: 'GET', url: '/api/cats/l0-budget', headers });
  assert.equal(after.statusCode, 200, after.payload);
  assert.ok(after.json().members.find((member) => member.catId === 'codex').tokens > before);
  assert.equal(after.json().members.length, budget.members.length + 1);
});
