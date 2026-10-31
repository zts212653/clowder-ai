import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { generatedStylesheetManifest } from './lib/vendor-stylesheet-check.mjs';

const sourceWeb = resolve(import.meta.dirname, '../packages/web');
const xtermCss = join(sourceWeb, 'node_modules/@xterm/xterm/css/xterm.css');

test('checked-in stylesheet bytes match the installed dependency and app sources', () => {
  const { checkedIn, generated } = generatedStylesheetManifest(sourceWeb, xtermCss);
  assert.equal(
    checkedIn,
    generated,
    'stylesheet manifest is stale; run pnpm -C packages/web sync:vendor-assets and commit the result',
  );
});

test('installed check detects an updated dependency stylesheet', () => {
  const root = mkdtempSync(join(tmpdir(), 'vendor-xterm-drift-'));
  try {
    const changedXterm = join(root, 'xterm.css');
    writeFileSync(changedXterm, `${readFileSync(xtermCss, 'utf8')}\n/* changed dependency */\n`);
    const { checkedIn, generated } = generatedStylesheetManifest(sourceWeb, changedXterm);
    assert.notEqual(checkedIn, generated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
