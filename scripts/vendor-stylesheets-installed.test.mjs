import assert from 'node:assert/strict';
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
