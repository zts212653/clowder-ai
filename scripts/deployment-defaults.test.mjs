import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  projectDeploymentProfiles,
  resolveDeploymentDefaults,
  resolveStartupDefaults,
} from '../packages/shared/src/deployment-defaults.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = (webPort, apiPort, reportPort) => ({
  repositoryFullName: 'synthetic-owner/fixture-repo',
  apiPort,
  webPort,
  envRegistryFrontendPort: reportPort,
  corsOrigins: [`http://localhost:${webPort}`, 'https://team.example'],
  roadmapPath: `docs/plans/ACTIVE-${webPort}.md`,
  brand: {
    name: 'Fixture',
    displayName: 'Fixture UI',
    shortName: 'F',
    hubName: 'Fixture Hub',
    tagline: 'Fixture team',
  },
});
const fixture = () => ({
  schemaVersion: 1,
  activeProfile: 'home',
  profiles: { home: profile(4510, 4599, 4400), opensource: profile(4620, 4699, 4620) },
  startupProfiles: JSON.parse(readFileSync(join(root, 'packages/shared/src/deployment-profiles.json'), 'utf8'))
    .startupProfiles,
});

test('configured defaults keep listen ports, documentation defaults and CORS distinct', () => {
  const actual = resolveDeploymentDefaults(fixture());
  assert.equal(actual.apiPort, 4599);
  assert.equal(actual.webPort, 4510);
  assert.equal(actual.roadmapPath, 'docs/plans/ACTIVE-4510.md');
  assert.equal(actual.envRegistryFrontendPort, 4400);
  assert.equal(actual.apiBaseUrl, 'http://localhost:4599');
  assert.equal(actual.frontendBaseUrl, 'http://localhost:4510');
  assert.deepEqual(actual.corsOrigins, ['http://localhost:4510', 'https://team.example']);
});

test('deployment repository coordinates come from the selected profile', () => {
  const input = fixture();
  input.profiles.home.repositoryFullName = 'synthetic-owner/home-repo';
  input.profiles.opensource.repositoryFullName = 'synthetic-owner/public-repo';
  assert.equal(resolveDeploymentDefaults(input).repositoryFullName, 'synthetic-owner/home-repo');
  assert.equal(resolveDeploymentDefaults(input).repositoryUrl, 'https://github.com/synthetic-owner/home-repo');
  assert.equal(
    resolveDeploymentDefaults(projectDeploymentProfiles(input, 'opensource')).repositoryFullName,
    'synthetic-owner/public-repo',
  );
  for (const value of ['', 'owner', '../repo', 'owner/repo/more', 'owner/repo\n', 'owner/repo;touch x']) {
    input.profiles.home.repositoryFullName = value;
    assert.throws(() => resolveDeploymentDefaults(input), /repositoryFullName/, value);
  }
});

test('startup profile values are validated before any shell assignment', () => {
  const input = fixture();
  const common = input.startupProfiles.dev.common;
  for (const value of ['2', '$(touch /tmp/not-executed)', '1\nPATH=bad']) {
    common.ANTHROPIC_PROXY_ENABLED = value;
    assert.throws(() => resolveStartupDefaults('dev', 'posix', input), /Invalid startup value/);
  }
  common.ANTHROPIC_PROXY_ENABLED = '1';
  common.PATH = 'bad';
  assert.throws(() => resolveStartupDefaults('dev', 'posix', input), /Invalid startup setting PATH/);
  delete common.PATH;
  delete common.MESSAGE_TTL_SECONDS;
  assert.throws(() => resolveStartupDefaults('dev', 'posix', input), /Missing startup setting/);
  assert.throws(() => resolveStartupDefaults('unknown', 'posix', fixture()), /Invalid startup profile/);
});

test('public projection selects configuration data and removes the inactive home values', () => {
  const input = fixture();
  const original = structuredClone(input);
  const projected = projectDeploymentProfiles(input, 'opensource');
  assert.deepEqual(input, original, 'projection must not mutate its source configuration');
  assert.deepEqual(projected, {
    schemaVersion: 1,
    activeProfile: 'opensource',
    profiles: { opensource: input.profiles.opensource },
    startupProfiles: input.startupProfiles,
  });
  assert.deepEqual(projectDeploymentProfiles(projected, 'opensource'), projected);
  assert.equal(resolveDeploymentDefaults(projected).apiPort, 4699);
  assert.equal(resolveDeploymentDefaults(projected).roadmapPath, 'docs/plans/ACTIVE-4620.md');
  assert.throws(() => projectDeploymentProfiles(input, 'missing'));
});

test('roadmap configuration rejects paths outside the documentation tree', () => {
  for (const roadmapPath of [
    '',
    '/docs/ACTIVE.md',
    'docs/../private.md',
    'docs/a/../ACTIVE.md',
    '../ACTIVE.md',
    'docs\\ACTIVE.md',
    'docs/ACTIVE.md\n',
    'https://team.example/ACTIVE.md',
  ]) {
    const input = fixture();
    input.profiles.home.roadmapPath = roadmapPath;
    assert.throws(() => resolveDeploymentDefaults(input), undefined, roadmapPath);
  }
});

// This is the source-only producer; public packages deliberately omit the exporter.
const exporter = join(root, 'scripts/sync-to-opensource.sh');
function artifactFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'f330-document-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = fixture();
  input.profiles.home.roadmapPath = overrides.home ?? 'docs/BACKLOG.md';
  input.profiles.opensource.roadmapPath = overrides.opensource ?? 'docs/ROADMAP.md';
  for (const [edition, config] of [
    ['source', input],
    ['public', projectDeploymentProfiles(input, 'opensource')],
  ]) {
    for (const file of ['scripts/read-deployment-default.mjs', 'packages/shared/src/deployment-defaults.ts']) {
      const path = join(dir, edition, file);
      mkdirSync(dirname(path), { recursive: true });
      cpSync(join(root, file), path);
    }
    writeFileSync(join(dir, edition, 'packages/shared/src/deployment-profiles.json'), JSON.stringify(config));
    mkdirSync(join(dir, edition, 'docs'), { recursive: true });
  }
  writeFileSync(join(dir, 'source/docs/BACKLOG.md'), '# BACKLOG\n| F123 | Public |\n| F999 | Private |\n');
  mkdirSync(join(dir, 'features'));
  writeFileSync(join(dir, 'features/index.json'), JSON.stringify({ features: [{ id: 'F123' }] }));
  const text = readFileSync(exporter, 'utf8');
  const projection = text.slice(text.indexOf('# 3m:'), text.indexOf('# 3n:'));
  assert.ok(projection.includes('TRANSFORM_COUNT'), 'actual canonical producer block');
  const portableSed = text.match(/^if sed --version[\s\S]*?^fi/m)?.[0];
  assert.ok(portableSed);
  const run = () =>
    spawnSync('bash', ['-e', '-c', `${portableSed}\n${projection}`], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        STAGING_DIR: join(dir, 'source'),
        FILTERED_DIR: join(dir, 'public'),
        FEATURES_EXPORT_DIR: join(dir, 'features'),
        TRANSFORM_COUNT: '0',
      },
    });
  return { dir, run };
}

test(
  'canonical document producer preserves the current filtered artifact bytes',
  { skip: !existsSync(exporter) },
  (t) => {
    const f = artifactFixture(t);
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.dir, 'public/docs/ROADMAP.md'), 'utf8'), '# Roadmap\n| F123 | Public |\n');
  },
);

for (const edition of ['home', 'opensource']) {
  test(`canonical producer rejects ${edition} document-coordinate drift`, { skip: !existsSync(exporter) }, (t) => {
    const f = artifactFixture(t, { [edition]: 'docs/MISSING.md' });
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /roadmapPath.*artifact/);
  });
}

test(
  'canonical producer fails when the configured source artifact is missing',
  { skip: !existsSync(exporter) },
  (t) => {
    const f = artifactFixture(t);
    unlinkSync(join(f.dir, 'source/docs/BACKLOG.md'));
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /roadmap.*must exist/i);
  },
);

for (const edition of ['source', 'public']) {
  for (const target of ['../packages/shared/src/deployment-profiles.json', 'MISSING.md']) {
    test(
      `canonical producer rejects ${edition} artifact symlink to ${target}`,
      { skip: !existsSync(exporter) },
      (t) => {
        const f = artifactFixture(t);
        const config = join(f.dir, edition, 'packages/shared/src/deployment-profiles.json');
        const before = readFileSync(config, 'utf8');
        const path = join(f.dir, edition, edition === 'source' ? 'docs/BACKLOG.md' : 'docs/ROADMAP.md');
        if (edition === 'source') unlinkSync(path);
        symlinkSync(target, path);
        const result = f.run();
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, /roadmap.*regular file/i);
        assert.equal(
          readFileSync(config, 'utf8'),
          before,
          'producer must not follow a destination link and overwrite its target',
        );
      },
    );
  }
  test(`canonical producer rejects symlinked ${edition} docs directory`, { skip: !existsSync(exporter) }, (t) => {
    const f = artifactFixture(t);
    renameSync(join(f.dir, edition, 'docs'), join(f.dir, edition, 'other-docs'));
    symlinkSync('other-docs', join(f.dir, edition, 'docs'));
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /roadmap.*regular file/i);
  });
}

test('invalid configured defaults fail rather than falling back to a home endpoint', () => {
  for (const invalid of [
    { ...fixture(), schemaVersion: 2 },
    { ...fixture(), activeProfile: 'missing' },
    { ...fixture(), profiles: {} },
    { ...fixture(), profiles: { home: { ...profile(4510, 4599, 4400), apiPort: 0 } } },
    { ...fixture(), profiles: { home: { ...profile(4510, 4599, 4400), webPort: 65_536 } } },
    { ...fixture(), profiles: { home: { ...profile(4510, 4599, 4400), corsOrigins: ['*'] } } },
  ]) {
    assert.throws(() => resolveDeploymentDefaults(invalid));
  }
});

test('launch scripts can read and project the same defaults in a fresh checkout with no dist or dependencies', (t) => {
  const checkout = mkdtempSync(join(tmpdir(), 'f330-defaults-checkout-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(join(checkout, 'packages/shared/src'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const file of [
    'packages/shared/src/deployment-defaults.ts',
    'scripts/read-deployment-default.mjs',
    'scripts/project-deployment-defaults.mjs',
    'scripts/brand-dictionary-helper.mjs',
    'scripts/deployment-brand-config.mjs',
    'assets/brand-dictionary.yaml',
  ]) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(join(root, file), join(checkout, file));
  }
  const config = join(checkout, 'packages/shared/src/deployment-profiles.json');
  writeFileSync(config, JSON.stringify(fixture()));
  const run = (script, ...args) =>
    execFileSync(process.execPath, [join(checkout, 'scripts', script), ...args], { cwd: checkout, encoding: 'utf8' });
  assert.equal(run('read-deployment-default.mjs', 'brand.name').trim(), 'Fixture');
  assert.equal(run('read-deployment-default.mjs', 'brand.displayName').trim(), 'Fixture UI');
  assert.equal(run('read-deployment-default.mjs', 'apiPort').trim(), '4599');
  assert.equal(run('read-deployment-default.mjs', 'webPort').trim(), '4510');
  assert.equal(run('read-deployment-default.mjs', 'apiBaseUrl').trim(), 'http://localhost:4599');
  assert.equal(run('read-deployment-default.mjs', 'roadmapPath').trim(), 'docs/plans/ACTIVE-4510.md');
  run('project-deployment-defaults.mjs', config, 'opensource');
  assert.equal(run('read-deployment-default.mjs', 'apiPort').trim(), '4699');
  assert.equal(run('read-deployment-default.mjs', 'webPort').trim(), '4620');
  assert.equal(run('read-deployment-default.mjs', 'apiBaseUrl').trim(), 'http://localhost:4699');
  assert.equal(run('read-deployment-default.mjs', 'roadmapPath').trim(), 'docs/plans/ACTIVE-4620.md');
  assert.equal(existsSync(join(checkout, 'node_modules')), false);
  assert.equal(existsSync(join(checkout, 'packages/shared/dist')), false);
});

test('actual Unix launcher uses configured defaults and preserves explicit overrides', (t) => {
  const checkout = mkdtempSync(join(tmpdir(), 'f330-defaults-launch-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  for (const file of [
    'scripts/start-dev.sh',
    'scripts/lib/node-runtime-guard.sh',
    'scripts/lib/redis-rdb-first.sh',
    'scripts/download-source-overrides.sh',
    'scripts/read-deployment-default.mjs',
    'packages/shared/src/deployment-defaults.ts',
  ]) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(join(root, file), join(checkout, file));
  }
  writeFileSync(join(checkout, 'packages/shared/src/deployment-profiles.json'), JSON.stringify(fixture()));
  const run = (overrides = {}) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source scripts/start-dev.sh --source-only --memory >/dev/null && trap - EXIT INT TERM && printf "%s/%s" "$API_PORT" "$WEB_PORT"',
      ],
      { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, ...overrides } },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(run(), '4599/4510');
  assert.equal(run({ API_SERVER_PORT: '4781', FRONTEND_PORT: '4780' }), '4781/4780');
  assert.equal(run({ API_SERVER_PORT: '', FRONTEND_PORT: '' }), '4599/4510');
  assert.equal(run({ API_SERVER_PORT: '0', FRONTEND_PORT: '0' }), '0/0');
});
