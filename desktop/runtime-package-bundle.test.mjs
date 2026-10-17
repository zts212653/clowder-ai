import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bundleDesktopApi } from './scripts/bundle-desktop-api.mjs';
import { bundleRuntimePackages } from './scripts/bundle-runtime-packages.mjs';
import { runRuntimeWitness, runtimePackageFixture } from './test-helpers/runtime-package-bundle-fixture.mjs';

test('a frozen export nested below a repository resolves its own dependencies before ancestor packages', async (t) => {
  const { base, root, peer, write, shared } = runtimePackageFixture(t);
  peer('dependencies/ancestor-shadow', 'frozen');
  const foreign = path.join(base, 'node_modules/ancestor-shadow');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'package.json'), '{"type":"module","exports":"./index.js"}');
  fs.writeFileSync(path.join(foreign, 'index.js'), "export const token='foreign-source';");
  write(`${shared}/dist/location.js`, "export {token as asset} from 'ancestor-shadow';");
  await bundleRuntimePackages(root);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false, 'build-only alias must not enter archives');
  const result = runRuntimeWitness(
    root,
    "import {asset} from '@cat-cafe/shared'; console.log(JSON.stringify({asset}));",
  );
  assert.equal(result.asset, 'frozen');
  assert.equal(fs.readFileSync(path.join(foreign, 'index.js'), 'utf8'), "export const token='foreign-source';");
});

test('canonical public entries share classes, singleton and JSON after a relocatable package-local split', async (t) => {
  const { base, root, shared } = runtimePackageFixture(t);
  const original = fs.readFileSync(path.join(root, shared, 'dist/index.js'), 'utf8');
  const receipt = await bundleRuntimePackages(root);
  assert.equal(receipt.packages.length, 2, 'both supported canonical packages are optimized');
  assert.match(fs.readFileSync(path.join(root, shared, 'dist/index.js'), 'utf8'), /\.desktop-bundle/);
  assert.equal(fs.readFileSync(path.join(root, shared, 'dist/index.js.desktop-original'), 'utf8'), original);
  const moved = path.join(base, 'moved');
  fs.renameSync(root, moved);
  const result = runRuntimeWitness(
    moved,
    `
    import {registerHooks} from 'node:module'; let sharedLoads=0;
    registerHooks({load(url,context,next){if(url.includes('/@cat-cafe/shared/'))sharedLoads++;return next(url,context);}});
    const a=await import('@cat-cafe/shared'), b=await import('@cat-cafe/shared/registry');
    const c=await import('@cat-cafe/shared/location');
    const d=await import('@clowder-ai/plugin-contract'), e=await import('@clowder-ai/plugin-contract/validation');
    console.log(JSON.stringify({same:a.catRegistry===b.catRegistry,classSame:a.CatRegistry===b.CatRegistry,
      instance:new a.CatRegistry() instanceof b.CatRegistry,peer:a.catRegistry.value,asset:c.asset,
      originalUrl:c.originalUrl,contractSame:d.ContractError===e.ContractError,
      json:d.schema.value,sharedLoads}));`,
  );
  assert.equal(result.same, true);
  assert.equal(result.classSame, true);
  assert.equal(result.instance, true);
  assert.equal(result.peer, 'private');
  assert.equal(result.asset, 7);
  assert.equal(result.json, 42);
  assert.equal(result.contractSame, true);
  assert.match(result.originalUrl, /\/moved\/dependencies\/@cat-cafe\/shared\/dist\/location\.js$/);
  assert.ok(result.sharedLoads < 12, 'many input leaves become shared generated chunks, not separate runtime loads');
});

test('aliases of one real root are bundled once while different private versions keep identity', async (t) => {
  const { root, write, contract } = runtimePackageFixture(t);
  contract('dependencies/@clowder-ai/plugin-contract-beta27', '27');
  contract('dependencies/@clowder-ai/same-version-contract', '21');
  fs.symlinkSync(
    path.join(root, 'dependencies/@clowder-ai/plugin-contract'),
    path.join(root, 'dependencies/@clowder-ai/same-contract'),
    'junction',
  );
  write('api/node_modules/owner/package.json', '{"name":"owner"}');
  contract('api/node_modules/owner/node_modules/@clowder-ai/plugin-contract', 'private');
  const receipt = await bundleRuntimePackages(root);
  assert.equal(receipt.packages.length, 5);
  assert.equal(new Set(receipt.packages.map((item) => item.canonicalRoot)).size, 5);
  const result = runRuntimeWitness(
    root,
    `
    const root=await import('@clowder-ai/plugin-contract');
    const alias=await import('@clowder-ai/same-contract');
    const next=await import('@clowder-ai/plugin-contract-beta27');
    const sameVersion=await import('@clowder-ai/same-version-contract');
    const own=await import('./api/node_modules/owner/node_modules/@clowder-ai/plugin-contract/dist/index.js');
    console.log(JSON.stringify({same:root.token===alias.token,different:root.token!==next.token,
      versions:[root.token.version,next.token.version,own.token.version],privateDifferent:own.token!==root.token,
      sameVersionDifferent:sameVersion.token!==root.token}));`,
  );
  assert.deepEqual(result, {
    same: true,
    different: true,
    versions: ['21', '27', 'private'],
    privateDifferent: true,
    sameVersionDifferent: true,
  });
});

test('replacing a hardlinked public entry never writes through to its source/cache', async (t) => {
  const { root, base, shared } = runtimePackageFixture(t);
  const entry = path.join(root, shared, 'dist/index.js');
  const original = fs.readFileSync(entry);
  const cache = path.join(base, 'original-cache.js');
  fs.linkSync(entry, cache);
  await bundleRuntimePackages(root);
  assert.deepEqual(fs.readFileSync(cache), original);
  assert.match(fs.readFileSync(entry, 'utf8'), /\.desktop-bundle/);
});

test('an internal nested ESM peer cannot silently move to a different external identity', async (t) => {
  const { root, write, peer, shared } = runtimePackageFixture(t);
  peer(`${shared}/dist/registry/node_modules/peer`, 'nested');
  write(
    `${shared}/dist/registry/CatRegistry.js`,
    "import {token} from 'peer'; export class CatRegistry{value=token} export const catRegistry=new CatRegistry();",
  );
  await assert.rejects(bundleRuntimePackages(root), /external dependency identity/);
  assert.equal(fs.existsSync(path.join(root, shared, 'dist/.desktop-bundle')), false);
});

for (const [name, code] of [
  ['dynamic import', 'export const load=(target)=>import(target);'],
  ['unknown meta', 'export const resolve=import.meta.resolve;'],
  [
    'dynamic require',
    "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export const load=(target)=>require(target);",
  ],
  [
    'loader alias',
    "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); const load=require; export {load};",
  ],
  [
    'inline factory result',
    "import {createRequire} from 'node:module'; export const classes=createRequire(import.meta.url)('./validation/index.js');",
  ],
  [
    'inline factory with opaque base',
    "import {createRequire} from 'node:module'; export const load=createRequire('/unowned/not-a-frozen-module.js');",
  ],
])
  test(`${name} fails closed before any supported package is modified`, async (t) => {
    const { root, write, shared } = runtimePackageFixture(t);
    const original = fs.readFileSync(path.join(root, shared, 'dist/index.js'));
    write('dependencies/@clowder-ai/plugin-contract/dist/index.js', code);
    await assert.rejects(bundleRuntimePackages(root), /Unsupported runtime package/);
    assert.deepEqual(fs.readFileSync(path.join(root, shared, 'dist/index.js')), original);
    assert.equal(fs.existsSync(path.join(root, shared, 'dist/.desktop-bundle')), false);
  });

for (const canonicalAlias of [false, true])
  test(`duplicate public entry targets reject before any write (canonicalAlias=${canonicalAlias})`, async (t) => {
    const { root, shared, write, manifest } = runtimePackageFixture(t);
    const entry = path.join(root, shared, 'dist/index.js');
    const original = fs.readFileSync(entry);
    if (canonicalAlias) fs.symlinkSync(entry, path.join(root, shared, 'dist/alias.js'), 'file');
    manifest.exports['./alias'] = { import: canonicalAlias ? './dist/alias.js' : './dist/index.js' };
    write(`${shared}/package.json`, JSON.stringify(manifest));
    await assert.rejects(bundleRuntimePackages(root), /Unsupported runtime package exports/);
    assert.deepEqual(fs.readFileSync(entry), original);
    assert.equal(fs.existsSync(`${entry}.desktop-original`), false);
    assert.equal(fs.existsSync(path.join(root, shared, 'dist/.desktop-bundle')), false);
  });

test('literal private JavaScript require cannot create a second class behind a bundled ESM export', async (t) => {
  const { root, write, shared } = runtimePackageFixture(t);
  write(
    `${shared}/dist/location.js`,
    `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export const classes=require('./registry/CatRegistry.js');`,
  );
  await assert.rejects(bundleRuntimePackages(root), /Unsupported runtime package.*require/);
  assert.equal(fs.existsSync(path.join(root, shared, 'dist/.desktop-bundle')), false);
});

test('the frozen producer orders package optimization before API bundling and archive consumers', () => {
  const source = fs.readFileSync(new URL('./scripts/frozen-runtime-deploy.mjs', import.meta.url), 'utf8');
  const exported = source.indexOf('const receipt = exportFrozenRuntime(');
  const local = source.indexOf('receipt.runtimePackages = await bundleRuntimePackages(out)');
  const api = source.indexOf('receipt.desktopApi = await bundleDesktopApi(');
  const final = source.indexOf("fs.writeFileSync(path.join(out, 'frozen-install.json')");
  assert.ok(exported >= 0 && local > exported && api > local && final > api);
});

test('optimized packages remain external API identities and can still feed the isolated hooks bundle', async (t) => {
  const { root, write, shared } = runtimePackageFixture(t);
  write(
    `${shared}/dist/registry/CatRegistry.js`,
    'export class CatRegistry {} export const catRegistry=new CatRegistry();',
  );
  write(`${shared}/dist/location.js`, 'export const asset=7;');
  write('api/package.json', '{"type":"module"}');
  write(
    'api/dist/index.js',
    `import {catRegistry} from '@cat-cafe/shared'; import {catRegistry as other} from '@cat-cafe/shared/registry'; export const same=catRegistry===other;`,
  );
  write(
    'api/dist/agent-hooks/index.js',
    `import {catRegistry} from '@cat-cafe/shared'; export async function syncAgentHooks(){return catRegistry.constructor.name;}`,
  );
  await bundleRuntimePackages(root);
  const receipt = await bundleDesktopApi(path.join(root, 'api'));
  assert.equal(receipt.bundledPackages.includes('@cat-cafe/shared'), false);
  assert.equal(receipt.agentHooks.bundledPackages.includes('@cat-cafe/shared'), true);
  const result = runRuntimeWitness(
    root,
    `const api=await import('./api/dist/index.desktop.js'); const hooks=await import('./api/dist/agent-hooks/index.desktop.js'); console.log(JSON.stringify({same:api.same,hook:await hooks.syncAgentHooks()}));`,
  );
  assert.deepEqual(result, { same: true, hook: 'CatRegistry' });
});

test('unknown export conditions and a linked entry outside the frozen output are rejected', async (t) => {
  const { root, base, write, shared, manifest } = runtimePackageFixture(t);
  write(
    `${shared}/package.json`,
    JSON.stringify({ ...manifest, exports: { '.': { import: './dist/index.js', browser: './dist/browser.js' } } }),
  );
  await assert.rejects(bundleRuntimePackages(root), /Unsupported runtime package exports/);
  write(`${shared}/package.json`, JSON.stringify(manifest));
  const entry = path.join(root, shared, 'dist/index.js');
  fs.unlinkSync(entry);
  const outside = path.join(base, 'outside.js');
  fs.writeFileSync(outside, 'export const value=1;');
  fs.symlinkSync(outside, entry, 'file');
  await assert.rejects(bundleRuntimePackages(root), /outside.*package|outside.*frozen/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'export const value=1;');
});
