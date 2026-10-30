import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const routes = new URL('../dist/routes/', import.meta.url).href;
const worker = `
  import assert from 'node:assert/strict';
  import {readFileSync} from 'node:fs';
  import {join} from 'node:path';
  const {dshSourceProfiles,readDshSetup} = await import(${JSON.stringify(`${routes}dsh-setup-service.js`)});
  const {createDshDumpSnapshot} = await import(${JSON.stringify(`${routes}dsh-setup-snapshot.js`)});
  const {resolveDshSetupLaunch} = await import(${JSON.stringify(`${routes}dsh-setup-launch.js`)});
  const {dshProfileState} = await import(${JSON.stringify(`${routes}native-dsh-profile.js`)});
  const {discoverDshRuntime} = await import(${JSON.stringify(`${routes}native-dsh-discovery.js`)});
  const root=process.env.DSH_TEST_ROOT;
  const args=[join(root,'package/lib/bin.js'),'--profile','acp'];
  if(process.env.DSH_TEST_RELATIVE==='1') {
    assert.throws(()=>resolveDshSetupLaunch(process.execPath,args,root),/dsh_setup_custom_startup/);
  } else {
    assert.deepEqual(dshSourceProfiles(),['acp','desktop']);
    assert.equal(dshProfileState(),'configured');
    assert.equal(discoverDshRuntime({npmCaches:[],resolveCommand:()=>process.execPath}).discoveryStatus,'configured');
    const snapshot=createDshDumpSnapshot(root,'acp');
    try {
      assert.equal(readFileSync(join(snapshot.directory,'profiles/acp/cordis.yml'),'utf8'),readFileSync(join(root,'expected.yml'),'utf8'));
      snapshot.verify();
    } finally {snapshot.dispose();}
    const launch=resolveDshSetupLaunch(process.execPath,args,root);
    const current=await readDshSetup(launch,'desktop');
    assert.equal(current.view.active.provider,'real-active');
    assert.deepEqual(current.view.source.providers.map(p=>p.id),['real-source']);
    if(process.env.DSH_TEST_BLANK==='1') {
      process.env.DSH_HOME=process.env.DSH_HOME===''?'   ':'';
      assert.equal((await readDshSetup(launch,'desktop')).view.revision,current.view.revision);
    }
  }
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-home-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    cwd = join(root, 'cwd');
  mkdirSync(home);
  mkdirSync(cwd);
  const active =
    '- id: credentials\n  name: "@deepseek-ai/dsh-credentials-local"\n- id: acp\n  config:\n    provider: real-active\n    model: active-model\n- id: llm-pi-ai\n  config:\n    providers:\n      real-active:\n        models: [{id: active-model}]\n';
  writeFileSync(join(root, 'expected.yml'), active);
  const source =
    '- id: llm-pi-ai\n  config:\n    providers:\n      real-source:\n        models: [{id: source-model}]\n';
  for (const native of [join(home, '.dsh'), join(root, ' home with spaces ')]) {
    for (const profile of ['acp', 'desktop']) {
      const dir = join(native, 'profiles', profile);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
      );
      writeFileSync(join(dir, 'cordis.yml'), active);
      writeFileSync(join(dir, 'cordis.patch.yml'), profile === 'desktop' ? source : '[]');
    }
  }
  // These would be read by the old empty/whitespace path handling.
  for (const decoy of [cwd, join(cwd, '   ')]) {
    const dir = join(decoy, 'profiles', 'cwd-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['decoy'] } } }));
    writeFileSync(join(dir, 'cordis.yml'), '[]');
    mkdirSync(join(decoy, 'profiles/acp'), { recursive: true });
    writeFileSync(join(decoy, 'profiles/acp/package.json'), '{}');
    writeFileSync(join(decoy, 'profiles/acp/cordis.yml'), 'cwd lookalike');
  }
  const pkg = join(root, 'package');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }));
  writeFileSync(
    join(pkg, 'lib/bin.js'),
    "import{readFileSync}from'node:fs';import{join}from'node:path';process.stdout.write(readFileSync(join(process.env.DSH_HOME,'profiles/acp/cordis.yml')));",
  );
  return { root, home, cwd };
}

for (const value of ['', '   ', 'absolute', 'relative', '~/relative'])
  test(`DSH home authority: ${JSON.stringify(value)}`, (t) => {
    const { root, home, cwd } = fixture(t);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
      cwd,
      env: {
        NODE_ENV: 'test',
        // This suite checks HOME resolution, using the intranet Host policy for its synthetic launcher.
        CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE: 'trusted-host',
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        DSH_HOME: value === 'absolute' ? join(root, ' home with spaces ') : value,
        DSH_TEST_ROOT: root,
        DSH_TEST_BLANK: value.trim() === '' ? '1' : '0',
        DSH_TEST_RELATIVE: ['relative', '~/relative'].includes(value) ? '1' : '0',
      },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
