// Reusable review fixture. All writes stay under the test wrapper's temporary HOME.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const author = resolve(import.meta.dirname, '../../'); // packages/api
const dist = file => pathToFileURL(resolve(author, 'dist', file)).href;
const { parseRawCatConfig, toAllCatConfigs } = await import(dist('config/cat-config-loader.js'));
const { memberConfigurationRevision } = await import(dist('config/member-config-revision.js'));

export function createRealRouterCatalogFixture() {
  assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1');
  assert.ok(process.env.HOME);
  const projectRoot = mkdtempSync(join(process.env.HOME, 'router-real-catalog-'));
  const ids = ['dsh', 'opus'];
  const catalog = {
    version: 2,
    breeds: ids.map(id => ({
      id: `${id}-fixture-breed`, catId: id, name: id, displayName: id,
      avatar: '/avatars/fixture.png', color: { primary: '#333333', secondary: '#eeeeee' },
      mentionPatterns: [`@${id}`], roleDescription: 'Isolated router fixture',
      defaultVariantId: `${id}-default`,
      variants: [{ id: `${id}-default`, clientId: 'anthropic', defaultModel: `${id}-fixture-model`,
        mcpSupport: false, cli: { command: 'fixture', outputFormat: 'stream-json' } }],
    })),
    roster: Object.fromEntries(ids.map(id => [id, { family: `${id}-fixture-breed`,
      roles: ['reviewer'], lead: true, available: true, evaluation: 'primary' }])),
    reviewPolicy: { requireDifferentFamily: true, preferActiveInThread: true,
      preferLead: true, excludeUnavailable: true },
    coCreator: { name: 'Fixture Owner', aliases: [], mentionPatterns: ['@fixture-owner'] },
  };
  const raw = JSON.stringify(catalog);
  const parsed = parseRawCatConfig(raw);
  mkdirSync(join(projectRoot, '.cat-cafe'));
  writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), raw, 'utf8');
  const configs = toAllCatConfigs(parsed);
  const revisions = Object.fromEntries(ids.map(id => {
    const revision = memberConfigurationRevision(projectRoot, id);
    assert.match(revision ?? '', /^[a-f0-9]{64}$/);
    return [id, revision];
  }));
  return { projectRoot, catalog, configs, revisions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { configs, revisions } = createRealRouterCatalogFixture();
  console.log(JSON.stringify({ schemaValid: true, catIds: Object.keys(configs), revisions }));
}
