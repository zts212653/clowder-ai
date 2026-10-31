#!/usr/bin/env node
/**
 * F212 Phase H post-close hotfix — structural anti-regression gates against
 * the removed shared-directory canary helper.
 *
 * Split from `check-no-codex-provider-exit-suppression-isolation.test.mjs` per
 * Sol R2 P1-2 (AGENTS.md 350-line hard cap).
 *
 * Sol R1 P1-A endpoint requirement (Cloud codex + Sol both flagged the
 * partial migration): once the shared-directory helper was removed, we need a
 * structural test that fires if any future PR reintroduces the coupling by
 * re-adding the helper or re-adding a call site. The tests here look only at
 * FILE CONTENTS (static grep) so they cannot false-green via runtime behavior.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REAL_REPO_ROOT } from './check-no-codex-provider-exit-suppression/test-scaffold.mjs';

describe('check-no-codex-provider-exit-suppression: structural anti-regression', () => {
  it('Sol R1 P1-A endpoint: no test file re-imports the removed shared-directory helper (structural gate)', async () => {
    // Only the two migrated suites — this test file (and its sibling isolation
    // test) legitimately reference the helper name in doc comments and titles.
    const suppressionTests = [
      join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression-literal.test.mjs'),
      join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression-ast.test.mjs'),
    ];
    const { readFile } = await import('node:fs/promises');
    // Assemble the regex from parts so this test file itself does not embed
    // the literal call pattern (else the line would falsely match itself).
    const helperName = ['with', 'Canary'].join('');
    const callPattern = new RegExp(`\\b${helperName}\\s*\\(`);
    for (const path of suppressionTests) {
      const contents = await readFile(path, 'utf8');
      // Count only code call sites — skip block-comment / line-comment mentions.
      const codeCallSites = contents.split('\n').filter((line) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false;
        return callPattern.test(line);
      });
      assert.equal(
        codeCallSites.length,
        0,
        `${path} must not call the removed shared-directory canary helper — migrate to makeIsolatedFixture(). Got ${codeCallSites.length} call site(s): ${codeCallSites.join(' | ')}`,
      );
    }
  });

  it('Sol R1 P1-A endpoint: test-scaffold.mjs does not export the removed helper (structural gate)', async () => {
    const scaffoldPath = join(
      REAL_REPO_ROOT,
      'scripts',
      'check-no-codex-provider-exit-suppression',
      'test-scaffold.mjs',
    );
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(scaffoldPath, 'utf8');
    // Assemble the pattern from parts to avoid this file matching itself.
    const helperName = ['with', 'Canary'].join('');
    const exportPattern = new RegExp(`export\\s+function\\s+${helperName}`);
    const exportMatch = contents.match(exportPattern);
    assert.equal(
      exportMatch,
      null,
      'test-scaffold.mjs must NOT re-export the removed shared-directory canary helper — it writes to shared production paths and cannot survive SIGKILL/SIGINT. Use makeIsolatedFixture() instead.',
    );
  });

  it('Sol R4 P1 convention gate #A: literal + AST tests do not reference REAL_REPO_ROOT (source-level convention guard, not JS capability isolation)', async () => {
    // Sol R5 P1 corrected framing: this gate is a source-level CONVENTION guard
    // — if the migrated suites don't spell REAL_REPO_ROOT or REPO_ROOT, they
    // won't accidentally use the real path via that constant. It is NOT a
    // proof of "physical impossibility" — a test could still get the real
    // path via `process.cwd()` or a hardcoded string. The real safety edge is
    // the `runGuard` helper's fail-CLOSED contract on the repoRoot argument
    // (Sol R5 P1 fix in test-scaffold.mjs), tested by the four `runGuard
    // fail-CLOSED contract` cases below.
    const suppressionTests = [
      join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression-literal.test.mjs'),
      join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression-ast.test.mjs'),
    ];
    const { readFile } = await import('node:fs/promises');
    const forbidden = ['REAL_REPO_ROOT', 'REPO_ROOT'];
    for (const path of suppressionTests) {
      const contents = await readFile(path, 'utf8');
      const codeLines = contents.split('\n').filter((line) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false;
        return true;
      });
      const bodyText = codeLines.join('\n');
      for (const token of forbidden) {
        const pattern = new RegExp(`\\b${token}\\b`);
        assert.equal(
          pattern.test(bodyText),
          false,
          `${path} must NOT reference the token ${token} in code — this is a convention guard against reintroducing the shared-tree fallback shape at source level. The real safety edge is runGuard's fail-CLOSED contract.`,
        );
      }
    }
  });

  // Sol R5 P1 — runGuard fail-CLOSED contract. The previous gate #B
  // (`\brunGuard\s*\(\s*\)`) was a name-only blacklist bypassed by
  // `runGuard({})`, `runGuard({ repoRoot: undefined })`, etc. Sol's fix:
  // remove the `?? REAL_REPO_ROOT` fallback in the helper so any missing /
  // null / undefined / empty repoRoot throws. These four tests exercise
  // the accept + three-reject contract.

  it('Sol R5 P1 helper fail-CLOSED contract: runGuard() with no argument throws', async () => {
    const { runGuard } = await import('./check-no-codex-provider-exit-suppression/test-scaffold.mjs');
    assert.throws(
      () => runGuard(),
      /repoRoot/,
      'runGuard() with no argument must throw — the shared-tree fallback was removed',
    );
  });

  it('Sol R5 P1 helper fail-CLOSED contract: runGuard({}) with no repoRoot throws', async () => {
    const { runGuard } = await import('./check-no-codex-provider-exit-suppression/test-scaffold.mjs');
    assert.throws(
      () => runGuard({}),
      /repoRoot/,
      'runGuard({}) with no repoRoot must throw — the shared-tree fallback was removed',
    );
  });

  it('Sol R5 P1 helper fail-CLOSED contract: runGuard({ repoRoot: undefined }) throws', async () => {
    const { runGuard } = await import('./check-no-codex-provider-exit-suppression/test-scaffold.mjs');
    assert.throws(
      () => runGuard({ repoRoot: undefined }),
      /repoRoot/,
      'runGuard({ repoRoot: undefined }) must throw — the shared-tree fallback was removed',
    );
  });

  it('Sol R5 P1 helper fail-CLOSED contract: runGuard({ repoRoot: fx.repoRoot }) with valid fixture accepts', async () => {
    const { makeIsolatedFixture, runGuard } = await import(
      './check-no-codex-provider-exit-suppression/test-scaffold.mjs'
    );
    const fx = makeIsolatedFixture();
    try {
      const result = runGuard({ repoRoot: fx.repoRoot });
      // A fresh fixture with only the placeholder Codex file is clean → exit 0.
      assert.equal(
        result.exitCode,
        0,
        `fresh fixture must be clean; got ${result.exitCode}, stderr=${result.stderr?.slice(0, 200)}`,
      );
    } finally {
      fx.cleanup();
    }
  });
});
