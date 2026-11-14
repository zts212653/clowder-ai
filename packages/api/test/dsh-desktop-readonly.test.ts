import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { DSH_DESKTOP_RUNTIME } from '../src/routes/dsh-desktop-runtime.js';
import { resolveDshDesktopLaunch } from '../src/utils/dsh-desktop-launch.js';

test(
  'Desktop bridge preserves record reads and refuses near-expiry OAuth before any refresh callback',
  { skip: !process.env.DSH_DESKTOP_TEST_COMMAND },
  async (t) => {
    const plan = resolveDshDesktopLaunch(process.env.DSH_DESKTOP_TEST_COMMAND!, []);
    assert.ok(plan);
    const nativeScope = dirname(dirname(dirname(plan.args[1]!)));
    const root = mkdtempSync(join(tmpdir(), 'dsh-readonly-contract-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const nativeHome = join(root, 'native');
    const nativeCwd = join(nativeHome, 'profiles/desktop');
    mkdirSync(nativeCwd, { recursive: true });
    const credentialPath = join(nativeHome, '.credentials.yaml');
    const bytes = `version: 1\nrefs:\n  FIXTURE_REF: fixture-ref-value\nrecords:\n  llm-pi-ai/fixture:\n    kind: grant\n    payload:\n      type: oauth\n      access: fake-access\n      refresh: fake-refresh\n      expires: ${Date.now() + 60_000}\n`;
    writeFileSync(credentialPath, bytes, { mode: 0o600 });
    const bridge = join(root, 'bridge.mjs'),
      worker = join(root, 'test.mjs');
    writeFileSync(bridge, DSH_DESKTOP_RUNTIME);
    writeFileSync(
      worker,
      `
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {apply} from './bridge.mjs';
const source = ${JSON.stringify({ nativeScope, nativeHome, nativeCwd, credentialPath })};
const load=path=>import(pathToFileURL(path).href);
const {Context}=await load(join(source.nativeScope,'cordis/lib/index.js'));
const {createLaunchEnvironmentSnapshot}=await load(join(source.nativeScope,'dsh-launch-environment/lib/index.js'));
const {resolveProviderAuth}=await load(join(dirname(source.nativeScope),'@earendil-works/pi-ai/dist/auth/resolve.js'));
const ctx=new Context();
ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([]));
await apply(ctx,source);
{
 const credentials=ctx.get('credentials');
 assert.equal((await credentials.resolve('FIXTURE_REF')).value,'fixture-ref-value');
 assert.deepEqual(await credentials.describe('FIXTURE_REF'),{configured:true,source:'file',writable:false});
 assert.deepEqual(await credentials.listRecords(),[{key:'llm-pi-ai/fixture',kind:'grant'}]);
 assert.deepEqual(await credentials.describeRecord('llm-pi-ai/fixture'),{configured:true,kind:'grant',writable:false});
 const record=await credentials.readRecord('llm-pi-ai/fixture');
 let refreshed=0,mutated=0;
 await assert.rejects(resolveProviderAuth({id:'fixture',auth:{oauth:{
   refresh:async()=>{refreshed++;return record.payload;},toAuth:()=>({})
 }}},{read:async()=>record.payload,modify:(_id,mutate)=>credentials.modifyRecord('llm-pi-ai/fixture',mutate)},{}),
   error=>error.cause?.message==='dsh_desktop_auth_read_only');
 await assert.rejects(credentials.modifyRecord('llm-pi-ai/fixture',()=>{mutated++;return record;}));
 await assert.rejects(credentials.set('FIXTURE_REF','changed'));
 await assert.rejects(credentials.unset('FIXTURE_REF'));
 await assert.rejects(credentials.deleteRecord('llm-pi-ai/fixture'));
 assert.equal(refreshed,0);assert.equal(mutated,0);
 console.log(JSON.stringify({refreshed,mutated,recordsReadable:true}));
}
`,
    );
    const { stdout } = await promisify(execFile)(plan.command, ['--expose-internals', worker], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(root, 'private') },
      windowsHide: true,
      timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(stdout), { refreshed: 0, mutated: 0, recordsReadable: true });
    assert.equal(readFileSync(credentialPath, 'utf8'), bytes);
  },
);
