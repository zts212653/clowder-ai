import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertNamedAlphaCheckout,
  deriveNamedAlphaCoordinates,
  namedAlphaEnvironment,
  parseNamedAlphaCoordinates,
  validateNamedAlphaEnvironment,
} from './alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './alpha-named-fixture.mjs';

function coordinates(f, extra = {}) {
  return deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    ...extra,
  });
}

test('coordinate consumer requires exact registered main lineage and frozen compiled target', (t) => {
  const f = namedAlphaFixture(t);
  const c = coordinates(f, { targetSha: f.head });
  assert.equal(assertNamedAlphaCheckout(c), f.head);
  assert.throws(() => assertNamedAlphaCheckout(c, { requireBuilds: true }), /ENOENT|compiled revision/);
  f.preparedBuilds();
  const env = namedAlphaEnvironment(c);
  assert.deepEqual(validateNamedAlphaEnvironment(env, f.alphaRoot), c);
  for (const [key, value] of [
    ['CAT_CAFE_DEPLOYMENT_ID', 'runtime'],
    ['CAT_CAFE_DATA_DIR', f.mainRoot],
    ['COLLECTIVE_SERVICE_PORT', '5211'],
    ['COLLECTIVE_SERVICE_ALLOWED_HOST_ORIGINS', 'http://localhost:3011'],
    ['CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED', '0'],
    ['CAT_CAFE_PROVISION_GLOBAL_SIDECAR', '1'],
    ['FRONTEND_URL', 'https://foreign.invalid'],
  ])
    assert.throws(() => validateNamedAlphaEnvironment({ ...env, [key]: value }, f.alphaRoot), /environment changed/);
  assert.throws(() => validateNamedAlphaEnvironment(env, f.mainRoot), /installation root changed/);
  writeFileSync(join(f.alphaRoot, 'packages/api/dist/.build-commit'), 'a'.repeat(40));
  assert.throws(() => validateNamedAlphaEnvironment(env, f.alphaRoot), /compiled revision/);
  assert.throws(() => parseNamedAlphaCoordinates(JSON.stringify({ ...c, extraAuthority: true })), /envelope changed/);
});

test('named coordinates neutralize global sidecar provisioning', (t) => {
  const f = namedAlphaFixture(t);
  const c = coordinates(f, { targetSha: f.head });
  assert.equal(namedAlphaEnvironment(c).CAT_CAFE_PROVISION_GLOBAL_SIDECAR, '0');
});

test('named coordinates protect actual sidecar and cloud defaults in every tuple role', (t) => {
  const f = namedAlphaFixture(t);
  const manifest = readFileSync(
    new URL('../../packages/api/src/domains/services/service-manifest.ts', import.meta.url),
    'utf8',
  );
  const servicePorts = [...manifest.matchAll(/^\s+port: (\d+),$/gm)].map((match) => Number(match[1]));
  const launcher = readFileSync(new URL('../start-dev.sh', import.meta.url), 'utf8');
  const proxyPort = Number(launcher.match(/PROXY_PORT=\$\{ANTHROPIC_PROXY_PORT:-(\d+)\}/)[1]);
  const cloud = readFileSync(new URL('../f247-cloud-services.mjs', import.meta.url), 'utf8');
  const cloudPort = Number(cloud.match(/DEFAULT_REMOTE_PORT = '(\d+)'/)[1]);
  assert.equal(servicePorts.length, 5, 'actual service manifest supplies the five sidecar defaults');
  for (const port of [...servicePorts, proxyPort, cloudPort]) {
    for (let index = 0; index < 5; index += 1) {
      const tuple = NAMED_ALPHA_PORTS.split(',');
      tuple[index] = String(port);
      assert.throws(() => coordinates(f, { ports: tuple.join(',') }), /non-protected/);
    }
  }
});

test('every tuple role rejects runtime, old Alpha and protected Redis aliases', (t) => {
  const f = namedAlphaFixture(t);
  for (const port of [3001, 3002, 3011, 3012, 4100, 4111, 5201, 5211, 6379, 6099, 6397, 6398, 6399, 6401]) {
    for (let index = 0; index < 5; index += 1) {
      const tuple = NAMED_ALPHA_PORTS.split(',');
      tuple[index] = String(port);
      assert.throws(() => coordinates(f, { ports: tuple.join(',') }), /non-protected/);
    }
  }
  for (const ports of ['5311,5312,5411,5511,015397', '5311,5312,5411,5511,65536', '5311,5312,5411,5311,15397'])
    assert.throws(() => coordinates(f, { ports }), /port tuple|non-protected/);
  for (const instance of ['../runtime', 'runtime/main-sync', 'f290;rm', 'F290', 'a--b'])
    assert.throws(() => coordinates(f, { instance }), /instance/);
});

test('unregistered, dirty, feature-lineage and path alias checkouts cannot become Alpha proof', (t) => {
  const f = namedAlphaFixture(t);
  const c = coordinates(f);
  const absent = coordinates(f, { instance: 'unregistered' });
  mkdirSync(absent.alphaRoot);
  assert.throws(() => assertNamedAlphaCheckout(absent), /not registered/);
  const alias = join(f.directory, 'main-alias');
  symlinkSync(f.mainRoot, alias, 'dir');
  assert.throws(() => coordinates(f, { mainRoot: alias }), /aliases/);
  writeFileSync(join(f.alphaRoot, 'scripts/alpha-worktree.sh'), '# changed');
  assert.throws(() => assertNamedAlphaCheckout(c), /tracked changes/);
  f.git(['restore', 'scripts/alpha-worktree.sh'], f.alphaRoot);
  writeFileSync(join(f.alphaRoot, 'feature-only'), 'outside main');
  f.git(['add', 'feature-only'], f.alphaRoot);
  f.git(['commit', '-m', 'not in main'], f.alphaRoot);
  assert.throws(() => assertNamedAlphaCheckout(c), /outside main lineage/);
  assert.equal(readFileSync(join(f.mainRoot, '.gitignore'), 'utf8').includes('.cat-cafe/'), true);
});

test('data and secret source symlinks including dangling links fail before lifecycle effects', (t) => {
  const f = namedAlphaFixture(t);
  symlinkSync(join(f.directory, 'not-created'), join(f.alphaRoot, '.cat-cafe'), 'dir');
  assert.throws(() => coordinates(f), /symlink/);
});

test('unrelated main work is preserved while dirty lifecycle controls cannot supply Alpha authority', (t) => {
  const f = namedAlphaFixture(t);
  writeFileSync(join(f.mainRoot, 'unrelated-design'), 'preserve co-creator work');
  assert.equal(coordinates(f).alphaRoot, f.alphaRoot);
  writeFileSync(join(f.mainRoot, 'scripts/alpha-worktree.sh'), '# uncommitted lifecycle substitution');
  assert.throws(() => coordinates(f), /committed unchanged launcher controls/);
  assert.equal(readFileSync(join(f.mainRoot, 'unrelated-design'), 'utf8'), 'preserve co-creator work');
});

test('uploads, transcripts and story annotation destinations cannot escape through directory aliases', (t) => {
  for (const name of ['uploads', 'transcripts', 'stories']) {
    const f = namedAlphaFixture(t);
    mkdirSync(join(f.alphaRoot, '.cat-cafe'));
    symlinkSync(join(f.directory, 'preserved-unrelated-home'), join(f.alphaRoot, '.cat-cafe', name), 'dir');
    assert.throws(() => coordinates(f), /symlink/);
  }
});
