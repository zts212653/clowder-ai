import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  checkCapabilityTipReferenceRegressions,
  checkPublicPackageScriptClosure,
} from './check-sync-public-preflight.mjs';

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cc-sync-public-preflight-'));
  tempRoots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commitAll(root, message) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'preflight@test.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Preflight Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', message], { cwd: root });
}

function tip(bodyPath) {
  return {
    id: 'feature-export-contract',
    kind: 'status_help',
    sourceRef: { path: 'docs/source.md', anchor: 'Source anchor' },
    structureSource: { path: 'docs/source.md', anchor: 'Source anchor' },
    bodySource: { path: bodyPath, anchor: 'Body anchor' },
    contexts: ['feature_dev'],
    audience: ['developer'],
    body: 'Explain the exported contract truthfully.',
    owner: 'sync',
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public package script closure', () => {
  it('rejects a root package command whose local script target is absent', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: { check: 'node scripts/missing-check.mjs' } }));

    const result = checkPublicPackageScriptClosure(root);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['package.json:check -> missing scripts/missing-check.mjs']);
  });

  it('accepts exact local targets and ignores glob expressions delegated to their command', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: { check: 'node scripts/check.mjs scripts/**/*.test.mjs' } }));
    write(root, 'scripts/check.mjs', 'export {};\n');

    const result = checkPublicPackageScriptClosure(root);

    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects a script path that escapes the exported repository root', () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    const escapedPath = `scripts/../../${basename(outsideRoot)}/outside.mjs`;
    write(outsideRoot, 'outside.mjs', 'export {};\n');
    write(root, 'package.json', JSON.stringify({ scripts: { check: `node ${escapedPath}` } }));

    const result = checkPublicPackageScriptClosure(root);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [`package.json:check -> outside export root ${escapedPath}`]);
  });
});

describe('capability-tip export reference regressions', () => {
  it('blocks a newly changed bodySource that is absent from the candidate export', () => {
    const root = makeRoot();
    write(root, 'docs/source.md', '# Source anchor\n');
    write(root, 'docs/body.md', '# Body anchor\n');
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([tip('docs/body.md')]));
    commitAll(root, 'baseline');

    const candidate = JSON.parse(readFileSync(join(root, 'packages/web/src/lib/capability-tips.seed.json'), 'utf8'));
    candidate[0].bodySource = { path: 'docs/internal-only.md', anchor: 'Body anchor' };
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify(candidate));

    const result = checkCapabilityTipReferenceRegressions(root);

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /feature-export-contract: bodySource newly points to missing path/);
  });

  it('does not turn an unchanged baseline warning into a new release blocker', () => {
    const root = makeRoot();
    write(root, 'docs/source.md', '# Source anchor\n');
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([tip('docs/legacy-internal.md')]));
    commitAll(root, 'baseline');

    const result = checkCapabilityTipReferenceRegressions(root);

    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});
