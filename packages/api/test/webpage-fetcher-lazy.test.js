import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleDesktopApi } from '../../../desktop/scripts/bundle-desktop-api.mjs';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(api, 'package.json'));
const { build } = require('esbuild');
const source = path.join(api, 'src/domains/signals/fetchers/webpage-fetcher.ts');
const compiled = path.join(api, 'dist/domains/signals/fetchers/webpage-fetcher.js');
const consumer = `
import assert from 'node:assert/strict';
import Module, {createRequire, registerHooks} from 'node:module';
const seen={cheerio:false,undici:false};
registerHooks({load(url,context,next){
 for(const name of Object.keys(seen))if(String(url).replaceAll('\\\\','/').includes('/'+name+'/'))seen[name]=true;
 return next(url,context);
}});
const api=await import(process.argv[1]);
assert.equal(new api.WebpageFetcher().canHandle({fetch:{method:'api'}}),false);
assert.deepEqual(seen,{cheerio:false,undici:false},'importing the fetcher must not load optional HTML/network clients');
let attempts=0;
const original=Module._load;
Module._load=function(request,...args){
 if(request==='cheerio' && ++attempts===1)throw Error('temporary parser load failure');
 return original.call(this,request,...args);
};
const html='<article><p>intro<table><tr><td>cell</td></tr></table><li>tail</li></article>';
assert.throws(()=>api.extractArticleBody(html),/temporary parser load failure/);
assert.equal(attempts,1);
assert.deepEqual(seen,{cheerio:false,undici:false});
const result=api.extractArticleBody(html);
assert.equal(typeof result,'string','extraction must remain synchronous');
assert.equal(attempts,2,'a failed load must be retried');
assert.deepEqual(seen,{cheerio:true,undici:true},'first real parsing must load the original full package');
assert.equal(api.extractArticleBody(html),result);
assert.equal(attempts,2,'the successful parser function must be cached');
Module._load=original;
const {load}=await import(process.argv[2]);
const $=load(html);
const container=$('article').first().length?$('article').first():$('main').first();
const parts=[];
container.find('p, li, blockquote, pre, td, dd').each((_,el)=>{const text=$(el).text().trim();if(text)parts.push(text);});
assert.equal(result,parts.join('\\n\\n'),'the original parse5-backed package semantics must be retained');
console.log('original parser loaded lazily, retried and cached');
`;

function assertLazy(target) {
  const originalPackage = import.meta.resolve('cheerio');
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', consumer, pathToFileURL(target).href, originalPackage],
    {
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.match(output, /original parser loaded lazily, retried and cached/);
}

test('webpage fetcher imports no optional parser, preserves synchronous parsing and retries a failed load', () => {
  assertLazy(compiled);
});

test('the real desktop bundler does not lift Cheerio into the startup graph', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lazy-html-'));
  try {
    const relative = 'domains/signals/fetchers/webpage-fetcher.js';
    fs.mkdirSync(path.join(fixture, 'dist', path.dirname(relative)), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
    const cheerio = path.resolve(require.resolve('cheerio'), '../../..');
    fs.symlinkSync(
      cheerio,
      path.join(fixture, 'node_modules/cheerio'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await build({
      entryPoints: [source],
      outfile: path.join(fixture, 'dist', relative),
      platform: 'node',
      format: 'esm',
      target: 'node24',
      bundle: false,
    });
    fs.writeFileSync(
      path.join(fixture, 'dist/index.js'),
      `export {extractArticleBody, WebpageFetcher} from './${relative}';`,
    );
    const receipt = await bundleDesktopApi(fixture);
    assert.equal(receipt.bundledPackages.includes('cheerio'), false);
    assertLazy(path.join(fixture, 'dist/index.desktop.js'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
