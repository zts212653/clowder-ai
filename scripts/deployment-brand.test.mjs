import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { projectDeploymentProfiles, resolveDeploymentDefaults } from '../packages/shared/src/deployment-defaults.ts';
import { projectBrandManifest, syncBrandManifest } from '../packages/web/scripts/sync-brand-manifest.mjs';
import { parseDictionary } from './brand-dictionary-helper.mjs';
import { assertDeploymentBrands, refreshDeploymentBrands } from './deployment-brand-config.mjs';

const input = () =>
  JSON.parse(readFileSync(new URL('../packages/shared/src/deployment-profiles.json', import.meta.url)));
const syntheticBrand = (label) => ({
  name: `${label} ASCII`,
  displayName: `${label} Display`,
  shortName: label,
  hubName: `${label} Hub`,
  tagline: `${label} collaboration space`,
});

test('runtime display literals cannot bypass deployment configuration', () => {
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    });
  const files = ['api', 'shared', 'mcp-server', 'web']
    .flatMap((name) => walk(join('packages', name, 'src')))
    .map((file) => file.split(sep).join('/'))
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/(?:__tests__|\.test\.)/.test(file));
  const findings = [];
  for (const file of files) {
    // These surfaces name historical works, legacy installation identity or a
    // deliberately fixed test fixture, rather than the current deployment.
    if (
      /\/app\/(?:dev|story-export)\/|DesktopUpdate|pwa-retirement-script|plugin-manager-fixtures|f306-native-effect-guard\/live-fixture/.test(
        file,
      )
    )
      continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isStringLiteralLike(node) ||
        [
          ts.SyntaxKind.TemplateHead,
          ts.SyntaxKind.TemplateMiddle,
          ts.SyntaxKind.TemplateTail,
          ts.SyntaxKind.JsxText,
        ].includes(node.kind)
      ) {
        let value = node.text ?? '';
        if (file.endsWith('redis-message-delivery-lua-scripts.ts')) value = value.replace(/^\s*--.*$/gm, '');
        const stableKey = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
        const memberLookup =
          /\/members\/(?:member-editor-changes|editor-presentation)\./.test(file) &&
          /^(?:Cat Caf[eé]|Clowder AI) (?:工具|tools)$/.test(value);
        // Official publisher identity and package-owned setup translation keys
        // name the plugin author/input, not this deployment's product label.
        let property = node.parent;
        while (property && !ts.isPropertyAssignment(property)) property = property.parent;
        const publisher =
          value === 'Clowder AI' &&
          property?.name.getText(source) === 'publisher' &&
          /(?:plugin\/runtime-composition|plugin-manager-live-api)\.ts$/.test(file);
        const packageCopyKey =
          file.endsWith('plugin-manager-copy.ts') &&
          ts.isArrayLiteralExpression(node.parent) &&
          node.parent.elements[0] === node;
        if (!stableKey && !memberLookup && !publisher && !packageCopyKey && /Cat Caf[eé]|Clowder AI/.test(value)) {
          findings.push(
            `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${value.slice(0, 100)}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(
    findings,
    [],
    'Runtime copy must read the selected deployment brand; translation keys and frozen identities stay stable',
  );
});

test('runtime display guard checks a fresh exported tree without Git metadata', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deployment-guard-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['api', 'shared', 'mcp-server', 'web'])
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
  const source = join(root, 'packages/api/src/output.ts');
  writeFileSync(source, 'export const title = deploymentDefaults.brand.displayName;');
  const command = ['--test', '--test-name-pattern=runtime display literals', fileURLToPath(import.meta.url)];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env });
  let result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  writeFileSync(source, "export const title = 'Clowder AI';");
  result = run();
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /packages\/api\/src\/output.ts/);
});

test('runtime deployment defaults preserve the selected synthetic brand variants', () => {
  const config = input();
  config.profiles[config.activeProfile].brand = syntheticBrand('Synthetic');
  assert.deepEqual(resolveDeploymentDefaults(config).brand, syntheticBrand('Synthetic'));
});

function repositoryFixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'deployment-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'assets'));
  for (const file of [...files, 'scripts/brand-dictionary-helper.mjs']) cpSync(file, join(root, file));
  const raw = readFileSync('assets/brand-dictionary.yaml', 'utf8').replace(
    /(- id: deployment\.repository[\s\S]*?)(?=\n {2}- id:|$)/,
    (block) =>
      block
        .replace(/(home:\s*\n\s*canonical: ")[^"]+/, '$1synthetic-owner/home')
        .replace(/(public:\s*\n\s*canonical: ")[^"]+/, '$1synthetic-owner/public'),
  );
  writeFileSync(join(root, 'assets/brand-dictionary.yaml'), raw);
  return root;
}

test('portable merge planner reads canonical coordinates with independent source and target roles', async (t) => {
  const root = repositoryFixture(t, [
    'scripts/clowder-merge-execution.mjs',
    'scripts/lib/clowder-merge-check-evidence.mjs',
  ]);
  const actual = await import(pathToFileURL(join(root, 'scripts/clowder-merge-execution.mjs')));
  assert.equal(actual.CAT_CAFE_REPOSITORY, 'synthetic-owner/home');
  assert.equal(actual.CLOWDER_REPOSITORY, 'synthetic-owner/public');
});

test(
  'home intake and daily writer retain their fixed canonical roles',
  {
    skip: !existsSync('sync-manifest.yaml') && 'automatic intake and the daily writer are home-only capabilities',
  },
  async (t) => {
    const root = repositoryFixture(t, [
      'scripts/lib/intake-github.mjs',
      'scripts/lib/intake-mechanical.mjs',
      'scripts/lib/daily-public-sync-pr.mjs',
      'scripts/lib/daily-public-sync-git.mjs',
    ]);
    const intake = await import(pathToFileURL(join(root, 'scripts/lib/intake-github.mjs')));
    assert.equal(intake.HOME_REPO, 'synthetic-owner/home');
    assert.equal(intake.SOURCE_REPO, 'synthetic-owner/public');
    const daily = await import(pathToFileURL(join(root, 'scripts/lib/daily-public-sync-pr.mjs')));
    const calls = [];
    assert.deepEqual(
      daily.readDailyPullRequests((args) => {
        calls.push(args);
        return '[]';
      }),
      [],
    );
    assert.equal(calls[0][calls[0].indexOf('--repo') + 1], 'synthetic-owner/public');
  },
);

test('importing dictionary coordinates cannot dispatch the parent program CLI arguments', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deployment-dictionary-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, 'consumer.mjs');
  const helper = new URL('./brand-dictionary-helper.mjs', import.meta.url).href;
  writeFileSync(
    consumer,
    `import { getRepositoryCoordinates } from ${JSON.stringify(helper)}; process.stdout.write(JSON.stringify(getRepositoryCoordinates()));`,
  );
  const result = execFileSync(process.execPath, [consumer, '--repository', 'unrelated-parent-option'], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(result).public, 'zts212653/clowder-ai');
});

test('public projection carries only its selected brand and does not mutate the source', () => {
  const config = input();
  const active = config.activeProfile;
  config.profiles[active].brand = syntheticBrand('Current');
  config.profiles.other = { ...config.profiles[active], brand: syntheticBrand('Other') };
  const before = structuredClone(config);
  const projected = projectDeploymentProfiles(config, 'other');
  assert.deepEqual(Object.keys(projected.profiles), ['other']);
  assert.deepEqual(resolveDeploymentDefaults(projected).brand, syntheticBrand('Other'));
  assert.deepEqual(config, before);
});

test('missing, incomplete or malformed brand data fails without a home fallback', () => {
  for (const brand of [
    undefined,
    null,
    {},
    { ...syntheticBrand('Custom'), name: '' },
    { ...syntheticBrand('Custom'), displayName: 'bad\nname' },
  ]) {
    const config = input();
    config.profiles[config.activeProfile].brand = brand;
    assert.throws(() => resolveDeploymentDefaults(config), /brand/i);
  }
});

test('checked-in runtime brands are generated from the canonical dictionary', () => {
  const config = input();
  const dictionary = parseDictionary(readFileSync(new URL('../assets/brand-dictionary.yaml', import.meta.url), 'utf8'));
  const original = structuredClone(config);
  const generated = refreshDeploymentBrands(config, dictionary);
  assert.deepEqual(config, original);
  assert.deepEqual(config, generated, 'run project-deployment-defaults --refresh-brands after dictionary edits');
  assert.doesNotThrow(() => assertDeploymentBrands(config, dictionary, config.activeProfile));
  assert.throws(
    () => assertDeploymentBrands({ ...config, profiles: {} }, dictionary, config.activeProfile),
    /Missing.*profile/,
  );
  const drifted = structuredClone(config);
  drifted.profiles[config.activeProfile].repositoryFullName = 'synthetic-owner/drifted';
  assert.throws(
    () => assertDeploymentBrands(drifted, dictionary, config.activeProfile),
    /repository.*canonical dictionary/,
  );
  for (const profile of Object.values(config.profiles)) profile.brand = syntheticBrand('Drift');
  assert.throws(() => assertDeploymentBrands(config, dictionary, config.activeProfile), /canonical dictionary/);
});

test('PWA projection changes only display fields and preserves installation identity', (t) => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/web/public/manifest.json', import.meta.url), 'utf8'));
  const original = structuredClone(manifest);
  const brand = syntheticBrand('Synthetic');
  assert.deepEqual(projectBrandManifest(manifest, brand), {
    ...manifest,
    name: brand.displayName,
    short_name: brand.shortName,
    description: brand.tagline,
  });
  assert.deepEqual(manifest, original);
  const root = mkdtempSync(join(tmpdir(), 'deployment-brand-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'public'));
  const path = join(root, 'public/manifest.json');
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(syncBrandManifest(root, brand), true);
  assert.deepEqual(JSON.parse(readFileSync(path)), projectBrandManifest(original, brand));
  assert.equal(syncBrandManifest(root, brand), false, 'unchanged preparation does not rewrite the file');
});
