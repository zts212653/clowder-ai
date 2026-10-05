import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cases } from '../../../scripts/f317-page-action/cases.mjs';
import { modelPromptSha256 } from '../../../scripts/f317-page-action/model-prompts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourcePath = join(root, 'docs/evidence/f317/2026-09-28-page-action-jev.json');
const fixturePath = join(root, 'packages/api/test/fixtures/f317-page-action.html');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function replay(source) {
  const dir = mkdtempSync(join(tmpdir(), 'f317-lineage-red-'));
  try {
    const path = join(dir, 'source.json');
    writeFileSync(path, JSON.stringify(source));
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/f317-page-action/replay.mjs',
        '--model=recorded',
        `--from=${path}`,
        '--only=open-note',
      ],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('recorded replay rejects a different case set', () => {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  source.casesSha256 = 'tampered';
  const result = replay(source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cases hash mismatch/);
});

test('recorded replay rejects model input drift inside a case', () => {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  source.schemaVersion = 2;
  source.casesSha256 = sha256(JSON.stringify(cases));
  source.fixtureSha256 = sha256(readFileSync(fixturePath));
  source.rows[0].modelInputSha256 = 'tampered';
  const result = replay(source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /model input mismatch/);
});

test('recorded replay rejects a different page fixture', () => {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  source.fixtureSha256 = 'tampered';
  const result = replay(source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture hash mismatch/);
});

test('recorded replay rejects a changed model prompt', () => {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  source.rows[0].selection.promptSha256 = 'tampered';
  const result = replay(source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /model prompt mismatch/);
});

test('committed selector reports preserve the same case, page and model-visible material', () => {
  const jev = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const sol = JSON.parse(readFileSync(join(root, 'docs/evidence/f317/2026-09-28-page-action-sol.json'), 'utf8'));
  const casesHash = sha256(JSON.stringify(cases));
  const fixtureHash = sha256(readFileSync(fixturePath));
  for (const report of [jev, sol]) {
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.casesSha256, casesHash);
    assert.equal(report.fixtureSha256, fixtureHash);
    assert.equal(report.rows.length, cases.length);
    for (const row of report.rows) {
      assert.equal(row.modelInputSha256, sha256(JSON.stringify(row.modelInput)));
      assert.equal(row.selection.promptSha256, modelPromptSha256(report.model, row.modelInput));
    }
  }
  assert.deepEqual(
    jev.rows.map((row) => row.id),
    sol.rows.map((row) => row.id),
  );
  assert.deepEqual(
    jev.rows.map((row) => row.modelInputSha256),
    sol.rows.map((row) => row.modelInputSha256),
  );
});
