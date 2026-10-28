import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { appGlobalCssFiles, syncStylesheets } from '../packages/web/scripts/vendor-stylesheets.mjs';
import { generatedStylesheetManifest } from './lib/vendor-stylesheet-check.mjs';

test('CSS publication binds the complete cascade to immutable bytes and preserves old pages across upgrades', () => {
  const root = mkdtempSync(join(tmpdir(), 'vendor-stylesheet-identity-'));
  const web = join(root, 'web');
  const ui = join(root, 'ui/src/styles.css');
  const xterm = join(root, 'xterm.css');
  const manifest = join(web, 'src/generated/vendor-stylesheets.json');
  mkdirSync(join(web, 'src/app'), { recursive: true });
  mkdirSync(join(root, 'ui/src'), { recursive: true });
  for (const file of appGlobalCssFiles) {
    writeFileSync(
      join(web, 'src/app', file),
      file === 'shell-v2.css' ? '@import "@cat-cafe/ui/styles.css";\n.shell { display: flex; }' : `/* ${file} */`,
    );
  }
  writeFileSync(ui, '.cafe-world-rail { display: flex; width: 52px; }');
  writeFileSync(xterm, '.xterm { position: relative; }');
  try {
    const before = syncStylesheets(web, xterm);
    assert.equal(before.length, 10);
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), before);
    const contents = before.map((url) => readFileSync(join(web, 'public', url), 'utf8'));
    for (const [index, url] of before.entries()) {
      const hash = createHash('sha256').update(contents[index]).digest('hex').slice(0, 16);
      assert.ok(url.endsWith(`.${hash}.css`), 'URL identifies its exact published content');
    }
    const shellIndex = before.findIndex((url) => url.includes('/shell-v2.'));
    assert.ok(contents[shellIndex].includes('width: 52px'));
    assert.ok(!contents[shellIndex].includes('@cat-cafe/ui'));
    const manifestTime = statSync(manifest).mtimeMs;
    assert.deepEqual(syncStylesheets(web, xterm), before);
    assert.equal(statSync(manifest).mtimeMs, manifestTime, 'unchanged sync must not trigger a module reload');

    writeFileSync(ui, '.cafe-world-rail { display: flex; width: 60px; }');
    const after = syncStylesheets(web, xterm);
    assert.notEqual(after[shellIndex], before[shellIndex], 'a transitive shared UI change gets a new URL');
    assert.deepEqual(
      after.filter((_, index) => index !== shellIndex),
      before.filter((_, index) => index !== shellIndex),
      'unaffected styles retain their content identity and cascade order',
    );
    for (const [index, url] of before.entries()) {
      assert.equal(readFileSync(join(web, 'public', url), 'utf8'), contents[index], 'old pages retain their CSS');
    }
    assert.match(readFileSync(join(web, 'public', after[shellIndex]), 'utf8'), /width: 60px/);
    assert.match(readFileSync(join(web, 'public/vendor/app/shell-v2.css'), 'utf8'), /width: 60px/);
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), after);

    rmSync(xterm);
    assert.throws(() => syncStylesheets(web, xterm), /ENOENT/);
    assert.deepEqual(
      JSON.parse(readFileSync(manifest, 'utf8')),
      after,
      'a failed publication must not publish a partial document asset list',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checked-in stylesheet bytes match the actual app and shared UI sources', () => {
  const sourceWeb = resolve(import.meta.dirname, '../packages/web');
  const { checkedIn, generated } = generatedStylesheetManifest(sourceWeb);
  assert.equal(
    checkedIn,
    generated,
    'stylesheet manifest is stale; run pnpm -C packages/web sync:vendor-assets and commit the result',
  );
});

test('source check detects a noncanonical manifest even when its JSON values match', () => {
  const root = mkdtempSync(join(tmpdir(), 'vendor-stylesheet-format-'));
  const sourceWeb = resolve(import.meta.dirname, '../packages/web');
  const web = join(root, 'web');
  try {
    mkdirSync(join(web, 'src/app'), { recursive: true });
    mkdirSync(join(web, 'src/generated'), { recursive: true });
    mkdirSync(join(root, 'ui/src'), { recursive: true });
    for (const file of appGlobalCssFiles) {
      copyFileSync(join(sourceWeb, 'src/app', file), join(web, 'src/app', file));
    }
    copyFileSync(join(sourceWeb, '../ui/src/styles.css'), join(root, 'ui/src/styles.css'));
    const original = readFileSync(join(sourceWeb, 'src/generated/vendor-stylesheets.json'), 'utf8');
    writeFileSync(join(web, 'src/generated/vendor-stylesheets.json'), JSON.stringify(JSON.parse(original)));
    const { checkedIn, generated } = generatedStylesheetManifest(web);
    assert.deepEqual(JSON.parse(checkedIn), JSON.parse(generated));
    assert.notEqual(checkedIn, generated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
