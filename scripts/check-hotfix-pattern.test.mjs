import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hotfixFixture } from './lib/hotfix-test-fixture.mjs';

function analyzed(result, hotfix) {
  assert.equal(result.status, hotfix ? 2 : 0, result.stderr || result.stdout);
  assert.equal(result.json?.hotfix, hotfix, result.stdout);
}

function failed(result) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.json?.hotfix, undefined, 'unknown analysis must not be consumed as hotfix=false');
  assert.equal(
    result.stderr.trim().split('\n').at(-1),
    'HOTFIX_ANALYSIS_UNAVAILABLE',
    'merge-gate merges stderr into stdout and parses the final line even after a nonzero exit',
  );
}

test('PR commits and diff are the same on main and feature checkouts', (t) => {
  const f = hotfixFixture(t, { subject: 'fix: repair behavior', files: { 'a.js': 'one\n', 'b.js': 'two\n' } });
  const main = f.run([], { PR_NUMBER: '12', GH_REPO: 'unrelated/repo' });
  analyzed(main, true);
  assert.match(main.stdout, /Code files changed: 2/);
  assert.equal(main.json.autoLabel, false);
  f.git('checkout', '-q', 'feature');
  const feature = f.run(['12']);
  analyzed(feature, true);
  assert.deepEqual(main.json, feature.json);
  assert.equal(main.stdout, feature.stdout);
  assert.ok(f.calls().every((args) => args.includes('example/hotfix-fixture')));
});

for (const keyword of ['fix(F167): repair', 'hotfix(web): repair', 'FIX(api)!: repair']) {
  for (const source of ['title', 'subject']) {
    test(`recognizes ${keyword} in ${source} via the production CLI`, (t) => {
      const f = hotfixFixture(t, { [source]: keyword });
      const result = f.run([], { PR_NUMBER: '12' });
      analyzed(result, true);
      assert.equal(result.json.autoLabel, true);
      assert.equal(result.json.labelApplied, null);
      assert.ok(f.calls().every((args) => args[1] !== 'edit'));
    });
  }
}

for (const subject of [
  'feat(memory): add search',
  'feat: document fix(scope): syntax',
  'docs: explain a fix in prose',
]) {
  test(`does not upgrade unrelated subject: ${subject}`, (t) => {
    const f = hotfixFixture(t, { subject, title: subject });
    analyzed(f.run(['--apply-label', '12']), false);
    assert.ok(f.calls().every((args) => args[1] !== 'edit'));
  });
}

test('explicit base and HEAD select a fixed local range on either checkout', (t) => {
  const f = hotfixFixture(t, { subject: 'hotfix(web): repair' });
  analyzed(f.run(['--base', f.base, '--head', f.head]), true);
  f.git('checkout', '-q', 'feature');
  analyzed(f.run([], { HOTFIX_BASE: f.base, HOTFIX_HEAD: f.head }), true);
  assert.deepEqual(f.calls(), []);
});

test('default local scan still uses origin/main..HEAD', (t) => {
  const f = hotfixFixture(t, { subject: 'fix: repair' });
  f.git('checkout', '-q', 'feature');
  analyzed(f.run(), true);
  assert.deepEqual(f.calls(), []);
});

test('PR diff excludes unrelated base-branch changes by using its merge base', (t) => {
  const f = hotfixFixture(t, { subject: 'fix: repair' });
  writeFileSync(join(f.repo, 'unrelated.js'), 'base branch change\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'feat: advance base');
  f.setMetadata({ baseRefOid: f.git('rev-parse', 'HEAD') });
  const result = f.run(['--pr', '12']);
  analyzed(result, true);
  assert.equal(result.json.codeFileCount, 1);
  assert.equal(result.json.commitCount, 1);
  assert.equal(result.json.scope.mergeBase, f.base);
});

test('preserves existing stopgap phrases without widening plain fix prose', (t) => {
  const f = hotfixFixture(t);
  // Replaces the old copied-regex tests: these cases now exercise production.
  for (const title of [
    'fix: redis connection timeout',
    'hotfix: urgent auth bypass',
    'quick fix for login crash',
    'minimal fix for null pointer',
    'band-aid for memory leak',
    'bandaid solution',
    'band aid patch',
    'workaround for flaky test',
    'temp fix for deployment',
    'temporary fix for CI',
    'temporary hack to unblock deploy',
    'temp workaround for upstream bug',
    'temp patch for regression',
    'temporary solution pending redesign',
    'Fix: uppercase prefix',
    'HOTFIX: critical security patch',
  ]) {
    f.setMetadata({ title });
    analyzed(f.run(['12']), true);
  }
  for (const title of [
    'feat: add temp file cleanup',
    'refactor: rename template variable',
    'docs: update README temp section',
    'chore: clean temp directory',
    'feat: temporary storage migration',
    'test: add template rendering test',
    'style: fix formatting in template.ts',
    'perf: optimize temperature calculation',
  ]) {
    f.setMetadata({ title });
    analyzed(f.run(['12']), false);
  }
  assert.ok(f.calls().every((args) => args[1] !== 'edit'));
});

test('PR explicit base/HEAD must agree with its metadata', (t) => {
  const f = hotfixFixture(t);
  analyzed(f.run(['12', '--base', f.base, '--head', f.head]), false);
  failed(f.run(['--apply-label', '12', '--head', f.base]));
  assert.ok(f.calls().every((args) => args[1] !== 'edit'));
});

test('missing local revisions fail rather than reporting zero changes', (t) => {
  const f = hotfixFixture(t);
  failed(f.run([], { HOTFIX_BASE: 'refs/heads/absent' }));
});

test('gh read failure and malformed or unrelated PR metadata fail closed', (t) => {
  const f = hotfixFixture(t);
  failed(f.run(['--apply-label', '12'], { HOTFIX_FIXTURE_FAIL: 'view' }));
  for (const patch of [
    { headRefOid: '' },
    { headRefOid: 'not-a-sha' },
    { url: 'https://github.com/other/repo/pull/12' },
    { number: 13 },
  ]) {
    f.setMetadata({
      headRefOid: f.head,
      url: 'https://github.com/example/hotfix-fixture/pull/12',
      number: 12,
      ...patch,
    });
    failed(f.run(['--apply-label', '12']));
  }
  assert.ok(f.calls().every((args) => args[1] !== 'edit'));
});

test('missing PR objects fetch the exact remote snapshot without switching branches', (t) => {
  const f = hotfixFixture(t, { subject: 'fix: repair' });
  const checkout = join(f.root, 'fresh');
  mkdirSync(checkout);
  // Independent object database: the PR head cannot be borrowed from the original checkout.
  f.git('clone', '-q', '--single-branch', '--branch', 'main', '--no-local', join(f.root, 'remote.git'), checkout);
  f.git('-C', checkout, 'config', 'remote.origin.url', 'https://github.com/example/hotfix-fixture.git');
  f.git(
    '-C',
    checkout,
    'config',
    `url.${join(f.root, 'remote.git')}.insteadOf`,
    'https://github.com/example/hotfix-fixture.git',
  );
  const result = f.run(['12'], {}, checkout);
  analyzed(result, true);
  assert.equal(f.git('-C', checkout, 'branch', '--show-current'), 'main');
});

test('unavailable PR objects and unrelated histories never become no-hotfix', (t) => {
  const f = hotfixFixture(t);
  f.setMetadata({ headRefOid: 'f'.repeat(40) });
  failed(f.run(['--apply-label', '12']));
  f.setMetadata({ headRefOid: f.head });
  f.git('checkout', '--orphan', 'unrelated');
  f.git('commit', '-qm', 'unrelated root');
  failed(f.run(['--base', f.base, '--head', 'HEAD']));
  assert.ok(f.calls().every((args) => args[1] !== 'edit'));
});

test('rejects ambiguous selectors, unknown arguments and shell input without side effects', (t) => {
  const f = hotfixFixture(t);
  const marker = join(f.root, 'injected');
  for (const args of [['--apply-label'], ['--unknown'], ['12', '13'], ['12', '--head'], ['--apply-label', '0']])
    failed(f.run(args));
  failed(f.run(['12'], { PR_NUMBER: '13' }));
  failed(f.run([], { PR_NUMBER: `12; echo injected >${marker} #` }));
  failed(f.run([], { HOTFIX_BASE: `$(echo injected >${marker})` }));
  assert.equal(existsSync(marker), false);
  assert.ok(f.calls().every((args) => args[1] !== 'edit'));
});

test('a cwd outside Git and a non-GitHub origin cannot target a PR', (t) => {
  const f = hotfixFixture(t);
  failed(f.run(['12'], {}, f.root));
  f.git('config', 'remote.origin.url', 'https://example.invalid/other/repo');
  failed(f.run(['--apply-label', '12']));
  assert.ok(f.calls().every((args) => args[1] !== 'edit'));
});

for (const [name, files, eligible] of [
  ['50 additions', { 'a.js': 'line\n'.repeat(50) }, true],
  ['51 additions', { 'a.js': 'line\n'.repeat(51) }, false],
  ['two code files', { 'a.js': 'one\n', 'b.js': 'two\n' }, false],
  ['docs only', { 'notes.md': 'notes\n' }, false],
  ['one code file plus docs', { 'a.js': 'one\n', 'notes.md': 'notes\n' }, true],
  ['binary code file with unknown line count', { 'a.js': Buffer.from([0, 1, 2]) }, false],
]) {
  test(`label boundary: ${name}`, (t) => {
    const f = hotfixFixture(t, { subject: 'fix: repair', files });
    const result = f.run(['--apply-label', '12']);
    analyzed(result, true);
    assert.equal(result.json.autoLabel, eligible);
    assert.equal(result.json.labelApplied, eligible ? true : null);
    assert.equal(f.calls().filter((args) => args[1] === 'edit').length, eligible ? 1 : 0);
  });
}

test('label failure is explicit and PR drift blocks the write', (t) => {
  const f = hotfixFixture(t, { title: 'fix(web): repair' });
  const result = f.run(['--apply-label', '12'], { HOTFIX_FIXTURE_FAIL: 'edit' });
  assert.equal(result.status, 1);
  assert.equal(result.json?.labelApplied, false);
  assert.match(result.json.labelError, /failure/);
  assert.equal(f.calls().filter((args) => args[1] === 'edit').length, 1);
  f.clearCalls();
  const drift = f.run(['--apply-label', '12'], { HOTFIX_FIXTURE_DRIFT: '1' });
  failed(drift);
  assert.equal(f.calls().filter((args) => args[1] === 'edit').length, 0);
});

test('commit bodies containing fix words do not change the subject-based contract', (t) => {
  const f = hotfixFixture(t);
  writeFileSync(join(f.repo, 'extra.js'), 'one\n');
  f.git('checkout', '-q', 'feature');
  f.git('add', '.');
  f.git('commit', '-qm', 'feat: extend behavior\n\nA fix: example in the body.');
  analyzed(f.run(), false);
});
