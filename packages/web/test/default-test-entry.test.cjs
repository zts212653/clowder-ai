const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.resolve(__dirname, '..');
const { scripts } = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8'));

function runDefaultEntry(t, failedStage = '') {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-web-test-entry-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/usr/bin/env node\n' +
      'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
      'if (process.argv[3] === process.env.TEST_ENTRY_FAILED_STAGE) process.exit(17);\n',
    { mode: 0o700 },
  );
  const result = spawnSync('/bin/sh', ['-c', scripts.test], {
    cwd: webRoot,
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      TEST_ENTRY_FAILED_STAGE: failedStage,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.ifError(result.error);
  return {
    status: result.status,
    calls: result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

const options = { skip: process.platform === 'win32' };

test('default Web tests run unit, core smoke and guards without the full journey suite', options, (t) => {
  const result = runDefaultEntry(t);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    ['run', 'test:unit'],
    ['run', 'test:smoke'],
    ['run', 'test:guards'],
  ]);
  assert.ok(scripts['test:browser'], 'the complete journey suite retains an explicit entry');
});

test('a unit failure stops the default entry before browser admission', options, (t) => {
  const result = runDefaultEntry(t, 'test:unit');
  assert.equal(result.status, 17);
  assert.deepEqual(result.calls, [['run', 'test:unit']]);
});

test('a smoke failure remains red and cannot be hidden by successful guards', options, (t) => {
  const result = runDefaultEntry(t, 'test:smoke');
  assert.equal(result.status, 17);
  assert.deepEqual(result.calls, [
    ['run', 'test:unit'],
    ['run', 'test:smoke'],
  ]);
});

test('core smoke does not prepare unrelated full-suite production artifacts', () => {
  assert.equal(scripts['pretest:smoke'], undefined);
});
