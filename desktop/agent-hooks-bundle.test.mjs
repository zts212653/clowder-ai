import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as bundler from './scripts/bundle-desktop-api.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-hooks-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('api/package.json', '{"type":"module"}');
  write(
    'dependencies/@cat-cafe/shared/package.json',
    '{"name":"@cat-cafe/shared","type":"module","exports":"./index.js"}',
  );
  write('dependencies/@cat-cafe/shared/index.js', 'export const token={};');
  fs.symlinkSync(
    path.join(root, 'dependencies'),
    path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return { root, write, api: path.join(root, 'api') };
}

test('the standard API build also emits isolated hooks without changing the API shared singleton', async (t) => {
  const { root, write, api } = fixture(t);
  write(
    'api/dist/index.js',
    `import {token} from '@cat-cafe/shared'; import {createRequire} from 'node:module';
    console.log(JSON.stringify({same:token===createRequire(import.meta.url)('@cat-cafe/shared').token}));`,
  );
  write('api/dist/agent-hooks/asset.json', '{"value":7}');
  write(
    'api/dist/agent-hooks/location.js',
    `import fs from 'node:fs'; import {token} from '@cat-cafe/shared';
    export const other=token; export const value=JSON.parse(fs.readFileSync(new URL('./asset.json',import.meta.url))).value;`,
  );
  write(
    'api/dist/agent-hooks/index.js',
    `import {token} from '@cat-cafe/shared'; import {other,value} from './location.js';
    export async function syncAgentHooks(){return {same:token===other,value};}`,
  );
  const receipt = await bundler.bundleDesktopApi(api);
  assert.ok(fs.existsSync(path.join(api, 'dist/agent-hooks/index.desktop.js')), 'hooks bundle must be emitted');
  assert.equal(receipt.agentHooks.entry, 'dist/agent-hooks/index.desktop.js');
  assert.ok(receipt.agentHooks.bundledPackages.includes('@cat-cafe/shared'));
  assert.ok(!receipt.bundledPackages.includes('@cat-cafe/shared'), 'API identity boundary remains unchanged');
  const moved = `${root}-moved`;
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.renameSync(root, moved);
  fs.unlinkSync(path.join(moved, 'node_modules'));
  fs.symlinkSync(
    path.join(moved, 'dependencies'),
    path.join(moved, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.deepEqual(
    JSON.parse(
      execFileSync(process.execPath, [path.join(moved, 'api/dist/index.desktop.js')], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    ),
    { same: true },
  );
  fs.renameSync(path.join(moved, 'dependencies/@cat-cafe/shared'), path.join(moved, 'shared-unreadable'));
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {syncAgentHooks} from './api/dist/agent-hooks/index.desktop.js'; console.log(JSON.stringify(await syncAgentHooks()));`,
    ],
    { cwd: moved, encoding: 'utf8', windowsHide: true },
  );
  assert.deepEqual(JSON.parse(result), { same: true, value: 7 });
  assert.ok(fs.existsSync(path.join(moved, 'api/dist/agent-hooks/index.js')));
});

test('hooks cannot relocate a private external peer or a dependency with location-bound assets', async (t) => {
  const { write, api } = fixture(t);
  write('api/dist/agent-hooks/index.js', `export {token as syncAgentHooks} from '@cat-cafe/shared';`);
  write('dependencies/@cat-cafe/shared/index.js', `import token from 'private-peer'; export {token};`);
  for (const dir of ['dependencies/private-peer', 'dependencies/@cat-cafe/shared/node_modules/private-peer']) {
    write(`${dir}/package.json`, '{"type":"module","main":"index.js"}');
    write(`${dir}/index.js`, 'export default {};');
  }
  assert.equal(typeof bundler.bundleDesktopAgentHooks, 'function', 'dedicated hook build is available');
  await assert.rejects(bundler.bundleDesktopAgentHooks(api), /external dependency identity/);
  write('dependencies/@cat-cafe/shared/index.js', 'export const token=import.meta.url;');
  await assert.rejects(bundler.bundleDesktopAgentHooks(api), /external asset boundary/);
});

test('the real compiled hooks bundle preserves owner admission, complete health and merged settings', async (t) => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceApi = path.join(workspace, 'packages/api');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-hook-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = path.join(root, 'api');
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('api/package.json', '{"type":"module"}');
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
  const graph = await build({
    entryPoints: [path.join(sourceApi, 'dist/agent-hooks/index.js')],
    bundle: true,
    write: false,
    outfile: path.join(api, 'dist/agent-hooks/index.desktop.js'),
    packages: 'external',
    platform: 'node',
    format: 'esm',
    metafile: true,
    logLevel: 'silent',
  });
  for (const input of Object.keys(graph.metafile.inputs)) {
    const file = path.resolve(input);
    const relative = path.relative(path.join(sourceApi, 'dist'), file);
    assert.ok(!relative.startsWith('..'), 'only the actual hook application closure is copied');
    write(`api/dist/${relative}`, fs.readFileSync(file));
  }
  const shared = fs.realpathSync(path.join(sourceApi, 'node_modules/@cat-cafe/shared'));
  const names = [
    '@cat-cafe/shared',
    'pino',
    'smol-toml',
    'yaml',
    'zod',
    'remark-gfm',
    'remark-math',
    'remark-parse',
    'unified',
  ];
  for (const name of names) {
    let source =
      name === '@cat-cafe/shared' ? shared : path.dirname(require.resolve(name, { paths: [sourceApi, shared] }));
    while (
      !fs.existsSync(path.join(source, 'package.json')) ||
      JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).name !== name
    )
      source = path.dirname(source);
    const target = path.join(root, 'dependencies', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  fs.symlinkSync(
    path.join(root, 'dependencies'),
    path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const receipt = await bundler.bundleDesktopAgentHooks(api);
  assert.ok(receipt.modules > 100, 'the real shared barrel is included only in this installer entry');
  assert.ok(receipt.bytes < 2_000_000);
  const bundled = path.join(api, receipt.entry);
  const code = fs.readFileSync(bundled, 'utf8');
  assert.doesNotMatch(code, /Server listening on|Starting API server/);
  write(
    'runner.mjs',
    `import assert from 'node:assert/strict';
    import fs from 'node:fs'; import path from 'node:path';
    const root=process.cwd(),project=path.join(root,'project'),home=path.join(root,'home');
    for(const dir of ['.claude/hooks/user-level','cat-cafe-skills','.cat-cafe'])
      fs.mkdirSync(path.join(project,dir),{recursive:true});
    fs.writeFileSync(path.join(project,'cat-cafe-skills/manifest.yaml'),'version: 1\\nskills: []\\n');
    for(const name of ['session-start-recall.sh','session-stop-check.sh'])
      fs.writeFileSync(path.join(project,'.claude/hooks/user-level',name),'#!/bin/bash\\necho fixture\\n');
    fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
    fs.writeFileSync(path.join(home,'.claude/settings.json'),JSON.stringify({env:{CUSTOM_SETTING:'preserved'}}));
    const cap=path.join(project,'.cat-cafe/capabilities.json'),initial='{"version":2,"capabilities":[]}';
    fs.writeFileSync(cap,initial);
    const {syncAgentHooks}=await import(process.argv[2]);
    const phases=[];const options={projectRoot:project,targetRoot:home,diagnostics:e=>phases.push(e.phase)};
    const status=await syncAgentHooks({...options,ownerAuthorized:false});
    assert.equal(fs.readFileSync(cap,'utf8'),initial);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home,'.claude/settings.json'))).env.CUSTOM_SETTING,'preserved');
    const authorized=await syncAgentHooks({...options,ownerAuthorized:true});
    assert.ok(phases.includes('capability-sync'));
    fs.writeFileSync(cap,'invalid-fixture-json');
    await syncAgentHooks({...options,ownerAuthorized:true});
    assert.equal(fs.readFileSync(cap,'utf8'),'invalid-fixture-json');
    assert.ok(['hook-files-health','claude-settings-health','skills-health','mcp-health']
      .every(phase=>phases.includes(phase)));
    process.stdout.write(JSON.stringify({status:status.status,authorized:authorized.status,
      targets:status.targets.map(({name,status})=>({name,status})),ownerPreserved:true,settingsPreserved:true}));`,
  );
  const run = (module) =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(root, 'runner.mjs'), pathToFileURL(module).href], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', LOG_DIR: path.join(root, 'logs') },
      }),
    );
  const original = run(path.join(sourceApi, 'dist/agent-hooks/index.js'));
  assert.equal(original.status, 'configured');
  assert.deepEqual(run(bundled), original);
});
