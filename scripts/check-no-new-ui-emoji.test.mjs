import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findAddedUiPictographs, runGit } from './check-no-new-ui-emoji.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./check-no-new-ui-emoji.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('flags raw pictographs added to production web UI with new-file line numbers', () => {
  const diff = `diff --git a/packages/web/src/components/memory/RecallLedger.tsx b/packages/web/src/components/memory/RecallLedger.tsx
--- a/packages/web/src/components/memory/RecallLedger.tsx
+++ b/packages/web/src/components/memory/RecallLedger.tsx
@@ -148,0 +149,2 @@
+<span>📊 消费账本</span>
+<span>👁 注意力成本</span>
`;

  assert.deepEqual(findAddedUiPictographs(diff), [
    {
      file: 'packages/web/src/components/memory/RecallLedger.tsx',
      line: 149,
      pictographs: ['📊'],
      text: '<span>📊 消费账本</span>',
    },
    {
      file: 'packages/web/src/components/memory/RecallLedger.tsx',
      line: 150,
      pictographs: ['👁'],
      text: '<span>👁 注意力成本</span>',
    },
  ]);
});

test('ignores removals, test fixtures, and designed SVG markup', () => {
  const diff = `diff --git a/packages/web/src/components/memory/RecallLedger.tsx b/packages/web/src/components/memory/RecallLedger.tsx
--- a/packages/web/src/components/memory/RecallLedger.tsx
+++ b/packages/web/src/components/memory/RecallLedger.tsx
@@ -149 +149 @@
-<span>📊 消费账本</span>
+<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z" /></svg>
diff --git a/packages/web/src/components/__tests__/fixture.test.tsx b/packages/web/src/components/__tests__/fixture.test.tsx
--- a/packages/web/src/components/__tests__/fixture.test.tsx
+++ b/packages/web/src/components/__tests__/fixture.test.tsx
@@ -0,0 +1 @@
+expect(text).toContain('📊');
`;

  assert.deepEqual(findAddedUiPictographs(diff), []);
});

test('confines source-level pictograph parsing to non-TSX modules', () => {
  const nonRenderingParser = `diff --git a/packages/web/src/components/rich/legacy-parser.ts b/packages/web/src/components/rich/legacy-parser.ts
--- a/packages/web/src/components/rich/legacy-parser.ts
+++ b/packages/web/src/components/rich/legacy-parser.ts
@@ -0,0 +1 @@
+const cleaned = title.replace(/^📥 /u, '');
`;
  const renderedCapableParser = nonRenderingParser
    .replaceAll('legacy-parser.ts', 'LegacyParser.tsx')
    .replace(');', '); // cafe-ui-pictograph-allow: parser compatibility reason');

  assert.deepEqual(findAddedUiPictographs(nonRenderingParser), []);
  assert.equal(findAddedUiPictographs(renderedCapableParser).length, 1);
});

test('does not let rendered JSX masquerade as a compatibility parser', () => {
  const diff = `diff --git a/packages/web/src/components/memory/RecallLedger.tsx b/packages/web/src/components/memory/RecallLedger.tsx
--- a/packages/web/src/components/memory/RecallLedger.tsx
+++ b/packages/web/src/components/memory/RecallLedger.tsx
@@ -0,0 +1,2 @@
+<span>📊 消费账本</span> {/* cafe-ui-pictograph-allow: compatibility parser reason */}
+<>{title.replace('📊', '消费账本')}</> {/* cafe-ui-pictograph-allow: compatibility parser reason */}
`;

  assert.equal(findAddedUiPictographs(diff).length, 2);
});

test('does not let multi-line JSX expressions borrow a parser annotation', () => {
  const diff = `diff --git a/packages/web/src/components/memory/RecallLedger.tsx b/packages/web/src/components/memory/RecallLedger.tsx
--- a/packages/web/src/components/memory/RecallLedger.tsx
+++ b/packages/web/src/components/memory/RecallLedger.tsx
@@ -0,0 +1,7 @@
+<>
+  {title.replace("x", "📊")} // cafe-ui-pictograph-allow: parser compatibility reason
+</>
+<span
+  aria-label={title.replace("x", "📊")} // cafe-ui-pictograph-allow: parser compatibility reason
+/>
+
`;

  assert.equal(findAddedUiPictographs(diff).length, 2);
});

test('allows only reasoned cat-paw expression copy, not semantic pictographs', () => {
  const allowed = `diff --git a/packages/web/src/components/CatGreeting.tsx b/packages/web/src/components/CatGreeting.tsx
--- a/packages/web/src/components/CatGreeting.tsx
+++ b/packages/web/src/components/CatGreeting.tsx
@@ -0,0 +1 @@
+<span>小团团来贴贴啦 🐾</span> {/* cafe-ui-paw-expression-allow: relationship voice copy */}
`;
  const unmarked = allowed.replace(' {/* cafe-ui-paw-expression-allow: relationship voice copy */}', '');
  const semantic = allowed.replace('小团团来贴贴啦 🐾', '📊 消费账本');

  assert.deepEqual(findAddedUiPictographs(allowed), []);
  assert.equal(findAddedUiPictographs(unmarked).length, 1);
  assert.equal(findAddedUiPictographs(semantic).length, 1);
});

test('reads git output larger than the 1 MiB default instead of failing closed', (t) => {
  // A throwaway repository with one committed 1.5 MiB file: independent of this repo's history depth.
  const fixture = mkdtempSync(join(tmpdir(), 'ui-emoji-guard-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=guard', '-c', 'user.email=guard@test', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: fixture,
        stdio: 'ignore',
      },
    );
  git('init', '-q');
  writeFileSync(join(fixture, 'large.txt'), `${'x'.repeat(127)}\n`.repeat(12 * 1024));
  git('add', 'large.txt');
  git('commit', '-q', '-m', 'large fixture');

  const output = runGit(['show', 'HEAD:large.txt'], { cwd: fixture });
  assert.equal(output.length, 1.5 * 1024 * 1024);
  // Node's 1 MiB default is exactly what used to make this guard fail closed on a large branch diff.
  assert.throws(() => runGit(['show', 'HEAD:large.txt'], { cwd: fixture, maxBuffer: 1024 * 1024 }), /ENOBUFS/u);
});

test('fails closed when the requested git comparison cannot be read', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, '--base', 'definitely-not-a-revision'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unable to read git diff/u);
  assert.doesNotMatch(result.stdout, /PASS/u);
});

test('web test command runs the no-new-UI-pictograph guard', () => {
  const pkg = JSON.parse(readFileSync(new URL('../packages/web/package.json', import.meta.url), 'utf8'));

  assert.match(pkg.scripts.test, /pnpm run test:guards/);
  assert.match(pkg.scripts['test:guards'], /check-no-new-ui-emoji\.mjs/);
});
