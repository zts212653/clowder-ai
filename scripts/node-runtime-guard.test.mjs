import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function runBash(snippet, env = {}) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', snippet], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      ...env,
    },
  });
}

function fakeNode(dir, version) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'node');
  const major = version.split('.')[0];
  writeFileSync(
    path,
    `#!/bin/bash
if [ "\${1:-}" = "-p" ]; then
  expr="\${2:-}"
  case "$expr" in
    *split*) printf '%s\\n' "${major}" ;;
    *process.versions.node*) printf '%s\\n' "${version}" ;;
    *process.version*) printf 'v%s\\n' "${version}" ;;
    *) printf '%s\\n' "${major}" ;;
  esac
  exit 0
fi
printf 'fake node ${version}\\n'
`,
    { mode: 0o755 },
  );
  return path;
}

test('node runtime guard rejects Node 26 and accepts Node 24', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cat-cafe-node-guard-'));
  try {
    const node26 = fakeNode(join(tmp, 'node26', 'bin'), '26.0.0');
    const node24 = fakeNode(join(tmp, 'node24', 'bin'), '24.16.0');

    const result = runBash(`
set -e
source scripts/lib/node-runtime-guard.sh
if node_runtime_supported "${node26}"; then
  printf 'bad-node26'
  exit 1
fi
node_runtime_supported "${node24}"
printf 'ok'
`);

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), 'ok');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('node runtime guard finds Homebrew node@24 before unsupported current node', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cat-cafe-node-guard-brew-'));
  try {
    fakeNode(join(tmp, 'current', 'bin'), '26.0.0');
    const expected = fakeNode(join(tmp, 'brew', 'node@24', 'bin'), '24.16.0');
    const brew = join(tmp, 'bin', 'brew');
    mkdirSync(join(tmp, 'bin'), { recursive: true });
    writeFileSync(
      brew,
      `#!/bin/bash
if [ "\${1:-}" = "--prefix" ] && [ "\${2:-}" = "node@24" ]; then
  printf '%s\\n' "${join(tmp, 'brew', 'node@24')}"
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    const result = runBash(
      `
set -e
source scripts/lib/node-runtime-guard.sh
find_supported_node_runtime
`,
      { PATH: `${join(tmp, 'current', 'bin')}:${join(tmp, 'bin')}:${process.env.PATH ?? ''}` },
    );

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(realpathSync(result.stdout.trim()), realpathSync(expected));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('node runtime guard re-execs to pinned Node 24 when current Node 25 is otherwise supported', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cat-cafe-node-guard-pin-'));
  try {
    fakeNode(join(tmp, 'current', 'bin'), '25.9.0');
    const expected = fakeNode(join(tmp, 'brew', 'node@24', 'bin'), '24.16.0');
    const brew = join(tmp, 'bin', 'brew');
    const script = join(tmp, 'guarded-script.sh');
    mkdirSync(join(tmp, 'bin'), { recursive: true });
    writeFileSync(
      brew,
      `#!/bin/bash
if [ "\${1:-}" = "--prefix" ] && [ "\${2:-}" = "node@24" ]; then
  printf '%s\\n' "${join(tmp, 'brew', 'node@24')}"
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    writeFileSync(
      script,
      `#!/bin/bash
source "${resolve(import.meta.dirname, '..')}/scripts/lib/node-runtime-guard.sh"
ensure_supported_node_runtime "$0"
command -v node
`,
      { mode: 0o755 },
    );

    const result = runBash(`"${script}"`, {
      PATH: `${join(tmp, 'current', 'bin')}:${join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
      CAT_CAFE_NODE_BIN: expected,
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const selectedNode = result.stdout.trim();
    const selectedVersion = spawnSync(selectedNode, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
    });
    assert.equal(selectedVersion.status, 0, `stdout:\n${selectedVersion.stdout}\nstderr:\n${selectedVersion.stderr}`);
    assert.match(selectedVersion.stdout.trim(), /^24\./);
    assert.match(result.stderr, /pinned to Node 24/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('preinstall node runtime check fails fast on Node 26 with install guidance', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CAT_CAFE_TEST_NODE_VERSION: '26.0.0',
      NODE_ENV: undefined, // clear so production-install guard doesn't fire first
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node 26\.0\.0 is not supported/);
  assert.match(result.stderr, /brew install node@24/);
});

test('preinstall node runtime check rejects Node 23 because root tests include node:sqlite workspace', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CAT_CAFE_TEST_NODE_VERSION: '23.11.0',
      NODE_ENV: undefined, // clear so production-install guard doesn't fire first
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node 23\.11\.0 is not supported/);
  assert.match(result.stderr, /expected >=24 <26/);
});

test('preinstall node runtime check accepts Node 24', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CAT_CAFE_TEST_NODE_VERSION: '24.16.0',
      NODE_ENV: undefined, // clear so production-install guard doesn't fire first
    },
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

// -- NODE_ENV / production-install guard (check-node-runtime.mjs) --

test('preinstall guard rejects NODE_ENV=production with fix instructions', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      CAT_CAFE_TEST_NODE_VERSION: '24.16.0',
      NODE_ENV: 'production',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /NODE_ENV=production detected/);
  assert.match(result.stderr, /env -u NODE_ENV/);
});

test('preinstall guard rejects npm_config_production=true', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      CAT_CAFE_TEST_NODE_VERSION: '24.16.0',
      npm_config_production: 'true',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm_config_production=true detected/);
});

test('preinstall guard allows NODE_ENV=production when SKIP guard is set', () => {
  const result = spawnSync(process.execPath, ['scripts/check-node-runtime.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      CAT_CAFE_TEST_NODE_VERSION: '24.16.0',
      NODE_ENV: 'production',
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
    },
  });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

test('package engines advertise the Node 24 floor required by recursive workspace tests', () => {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

  assert.equal(pkg.engines.node, '>=24.0.0');
  assert.doesNotMatch(pkg.engines.node, /<\s*26/);
});

test('desktop release workflows install with Node 24 to satisfy the root preinstall guard', () => {
  const workflowPaths = ['.github/workflows/build-mac-dmg.yml', '.github/workflows/build-windows-desktop.yml'];

  for (const workflowPath of workflowPaths) {
    const workflow = readFileSync(resolve(import.meta.dirname, '..', workflowPath), 'utf8');
    assert.match(workflow, /node-version:\s*24\b/, workflowPath);
    assert.doesNotMatch(workflow, /node-version:\s*22\b/, workflowPath);
  }
});

test('bootstrap installers require and install Node 24 to match the root preinstall guard', () => {
  const installSh = readFileSync(resolve(import.meta.dirname, '..', 'scripts/install.sh'), 'utf8');
  const setupSh = readFileSync(resolve(import.meta.dirname, '..', 'scripts/setup.sh'), 'utf8');
  const initCafeSh = readFileSync(resolve(import.meta.dirname, '..', 'scripts/init-cafe.sh'), 'utf8');
  const installPs1 = readFileSync(resolve(import.meta.dirname, '..', 'scripts/install.ps1'), 'utf8');

  assert.match(installSh, /Install Node\.js 24\+/);
  assert.match(installSh, /\[\[\s+"\$v"\s+-lt\s+24\s+\]\]/);
  assert.match(installSh, /\[\[\s+"\$v"\s+-ge\s+26\s+\]\]/);
  assert.match(installSh, /\bfnm install 24\b/);
  assert.match(installSh, /\bfnm use 24\b/);
  assert.match(installSh, /\bfnm default 24\b/);
  assert.match(installSh, /brew install node@24/);
  assert.match(installSh, /node_24\.x/);
  assert.match(installSh, /setup_24\.x/);
  assert.match(installSh, /Could not install Node\.js 24/);
  assert.match(installSh, /Node\.js .* already installed \(>= 24 and < 26\)/);
  assert.doesNotMatch(installSh, /node@20|node_20\.x|setup_20\.x|fnm (?:install|use|default) 20|>= 20|Node\.js 20\+/);

  for (const [scriptPath, script] of [
    ['scripts/setup.sh', setupSh],
    ['scripts/init-cafe.sh', initCafeSh],
  ]) {
    assert.match(script, /24\+/, scriptPath);
    assert.match(script, /-lt 24/, scriptPath);
    assert.match(script, /-ge 26/, scriptPath);
    assert.match(script, />= 24/, scriptPath);
    assert.match(script, /< 26/, scriptPath);
    assert.doesNotMatch(script, /20\+|>= 20|-lt 20/, scriptPath);
  }

  assert.match(installPs1, /\$nodeMajor -ge 24 -and \$nodeMajor -lt 26/);
  assert.match(installPs1, /winget install -e --id OpenJS\.NodeJS\.LTS --version 24\.\d+\.\d+ /);
  assert.doesNotMatch(installPs1, /winget install OpenJS\.NodeJS\.LTS --accept-source-agreements/);
  assert.match(installPs1, /Node\.js >= 24 and < 26 required/);
  assert.match(installPs1, /need >= 24 and < 26/);
  assert.doesNotMatch(installPs1, /\$nodeMajor -ge 20|>= 20|need >= 20/);
  assert.doesNotMatch(installPs1, /\$nodeMajor -ge 24\) \{/);
});
