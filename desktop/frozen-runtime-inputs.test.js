const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, test } = require('node:test');

let readFrozenRuntimeInputs;
before(async () => {
  ({ readFrozenRuntimeInputs } = await import('./scripts/frozen-runtime-inputs.mjs'));
});

function sourceDirectory(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const source = fs.mkdtempSync(path.join(parent, 'frozen-runtime-inputs-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(source)), parent);
    fs.rmSync(source, { recursive: true, force: true });
  });
  return source;
}

test('reads every tracked runtime input beyond 1 MiB without adding untracked or unrelated files', async (t) => {
  const source = sourceDirectory(t);
  execFileSync('git', ['init', '-q'], { cwd: source });
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: source, input: 'fixture' })
    .toString()
    .trim();
  const runtime = [
    ...Array.from(
      { length: 9000 },
      (_, index) => `packages/web/src/${String(index).padStart(5, '0')}-${'x'.repeat(120)}.ts`,
    ),
    'packages/web/src/猫猫 空格.ts',
    'scripts/setup.mjs',
    'patches/fix.patch',
  ];
  assert.ok(Buffer.byteLength(`${runtime.join('\0')}\0`) > 1024 * 1024);
  const tracked = [...runtime, 'docs/design.md', 'packages-archive/not-a-runtime-input.ts'];
  execFileSync('git', ['update-index', '-z', '--index-info'], {
    cwd: source,
    input: tracked.map((relative) => `100644 ${blob}\t${relative}\0`).join(''),
  });
  fs.mkdirSync(path.join(source, 'packages'));
  fs.writeFileSync(path.join(source, 'packages/untracked.txt'), 'not in the index');
  const actual = await readFrozenRuntimeInputs(source);
  assert.equal(actual.length, runtime.length);
  assert.deepEqual(new Set(actual), new Set(runtime));
});

test('reads prepared release inventory without a Git checkout and keeps the runtime path scope', async (t) => {
  const source = sourceDirectory(t);
  const runtime = ['packages/api/src/index.ts', 'scripts/setup.mjs', 'patches/fix.patch'];
  fs.writeFileSync(path.join(source, '.build-input-files.json'), JSON.stringify([...runtime, 'docs/design.md']));
  assert.deepEqual(await readFrozenRuntimeInputs(source), runtime);
});

test('rejects a failed Git enumeration instead of silently returning an empty artifact inventory', async (t) => {
  const source = sourceDirectory(t);
  await assert.rejects(async () => readFrozenRuntimeInputs(source), /not a git repository|exit/i);
});
