import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts/compile-system-prompt-l0.mjs');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'l0-cli-output-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profileDir = join(directory, 'profile');
  mkdirSync(profileDir);
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
  const template = join(directory, 'cat-template.json');
  copyFileSync(join(root, 'cat-template.json'), template);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    LOG_DIR: join(directory, 'logs'),
    CAT_TEMPLATE_PATH: template,
    CAT_CAFE_DATA_DIR: directory,
  };
  const run = (args, overrides = {}) =>
    spawnSync(process.execPath, args, {
      cwd: directory,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 20_000,
    });
  const library = run([
    '--input-type=module',
    '-e',
    `
    import { compileL0 } from ${JSON.stringify(pathToFileURL(script).href)};
    process.stdout.write(await compileL0({ catId: 'codex', profileDir: ${JSON.stringify(profileDir)} }));
  `,
  ]);
  assert.equal(library.status, 0, library.stderr);
  assert.match(library.stdout, /Identity constant: `@codex`/);
  const args = [script, '--cat', 'codex', '--profile-dir', profileDir];
  return { run, args, expected: library.stdout, directory };
}

function assertDiagnostic(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Live L0 diagnostic: configurationRevision=[a-f0-9]+ inputDigest=[a-f0-9]{64}/);
}

test('real diagnostic CLI stdout equals compileL0 byte for byte and remains stable', (t) => {
  const { run, args, expected } = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const actual = run(args);
    assertDiagnostic(actual);
    assert.equal(actual.stdout.length, expected.length, 'stdout must contain only the compiled prompt');
    assert.equal(actual.stdout, expected);
  }
});

test('real diagnostic CLI --out writes only the prompt file and leaves stdout empty', (t) => {
  const { run, args, expected, directory } = fixture(t);
  const path = join(directory, 'prompt.md');
  const actual = run([...args, '--out', path]);
  assertDiagnostic(actual);
  assert.equal(actual.stdout.length, 0, '--out must not emit diagnostic JSON to stdout');
  assert.equal(readFileSync(path, 'utf8'), expected);
});

test('malformed local workflow warnings stay on stderr without changing prompt stdout', (t) => {
  const { run, args, expected, directory } = fixture(t);
  const overlays = join(directory, '.cat-cafe/prompt-overlays');
  mkdirSync(overlays, { recursive: true });
  writeFileSync(join(overlays, 'workflow-triggers.local.yaml'), 'invalid: [\n');
  for (const NODE_ENV of ['test', undefined]) {
    const actual = run(args, { NODE_ENV });
    assertDiagnostic(actual);
    assert.match(actual.stderr, /malformed YAML in .*workflow-triggers\.local\.yaml/);
    assert.equal(actual.stdout.length, expected.length, 'warning JSON must not become prompt bytes');
    assert.equal(actual.stdout, expected);
    const outPath = join(directory, 'degraded-prompt.md');
    const file = run([...args, '--out', outPath], { NODE_ENV });
    assertDiagnostic(file);
    assert.match(file.stderr, /malformed YAML in .*workflow-triggers\.local\.yaml/);
    assert.equal(file.stdout, '');
    assert.equal(readFileSync(outPath, 'utf8'), expected);
  }
});
