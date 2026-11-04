import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertPublicationBranchesMatch,
  parsePublicationBranches,
  readPublicationBranches,
} from './lib/publication-branches.mjs';

test('library imports work from a stdin program without pretending to be a CLI invocation', () => {
  const uri = new URL('./lib/publication-branches.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    encoding: 'utf8',
    input: `import { readPublicationBranches } from ${JSON.stringify(uri)}; console.log(readPublicationBranches().releaseBranch);`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'main');
});

test('the versioned policy selects integration independently while release stays on main', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'publication-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  const before = { version: 1, integrationBranch: 'main', releaseBranch: 'main' };
  const after = { ...before, integrationBranch: 'next' };
  for (const policy of [before, after]) {
    writeFileSync(join(root, 'scripts/publication-branches.json'), JSON.stringify(policy));
    assert.deepEqual(readPublicationBranches(root), policy);
    assertPublicationBranchesMatch(policy, parsePublicationBranches(JSON.stringify(policy)), 'same source');
  }
  assert.throws(
    () => assertPublicationBranchesMatch(before, after, 'frozen source'),
    /branch policy mismatch: frozen source/,
  );
});

test('missing or unsupported policies fail before selecting a branch', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'missing-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => readPublicationBranches(root), /ENOENT/);
  const valid = { version: 1, integrationBranch: 'main', releaseBranch: 'main' };
  for (const invalid of [
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, integrationBranch: '--all' },
    { ...valid, releaseBranch: 'next' },
    { ...valid, force: true },
  ]) {
    assert.throws(() => parsePublicationBranches(JSON.stringify(invalid)), /invalid publication branch policy/);
  }
});
