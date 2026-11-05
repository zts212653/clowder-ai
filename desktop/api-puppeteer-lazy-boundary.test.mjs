import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleDesktopApi } from './scripts/bundle-desktop-api.mjs';

test('desktop keeps the browser dependency outside the eager bundle until its first use', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lazy-browser-'));
  const write = (relative, source) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };
  try {
    write('package.json', '{"type":"module"}');
    write('node_modules/puppeteer-core/package.json', '{"type":"module","main":"index.js"}');
    write('node_modules/puppeteer-core/index.js', "import {value} from 'browser-leaf'; export default {value};");
    write('node_modules/browser-leaf/package.json', '{"type":"module","main":"index.js"}');
    write('node_modules/browser-leaf/index.js', 'globalThis.browserLeafLoaded=true; export const value=7;');
    write(
      'dist/index.js',
      "export async function useBrowser(){return (await import('puppeteer-core')).default.value;}",
    );
    const receipt = await bundleDesktopApi(root);
    write(
      'run.mjs',
      "import {useBrowser} from './dist/index.desktop.js'; const before=globalThis.browserLeafLoaded===true; const value=await useBrowser(); console.log(JSON.stringify({before,value,after:globalThis.browserLeafLoaded}));",
    );
    const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'run.mjs')], { encoding: 'utf8' }));
    assert.deepEqual(result, { before: false, value: 7, after: true });
    assert.equal(receipt.bundledPackages.includes('puppeteer-core'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
