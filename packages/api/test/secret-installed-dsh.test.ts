import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// Exercise the production supervisor without propagating test-only loaders into the isolated client cwd.
import { AcpClient } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { prepareDshSecretPatch } from '../src/domains/cats/services/agents/providers/dsh-secret-patch.js';

test(
  'installed DSH loads its exact guard overlay before ACP and blocks native/nested registry effects',
  {
    timeout: 30000,
    skip: spawnSync('dsh', ['--version'], { timeout: 5000 }).status !== 0,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'secret-installed-dsh-'));
    const fixture = join(root, 'probe.mjs');
    const receipt = join(root, 'receipt.json');
    const patch = join(root, 'probe.patch.yml');
    const key = ['ghp', '_', 'D'.repeat(36)].join('');
    await writeFile(
      fixture,
      `import {writeFileSync} from 'node:fs';
export const inject = ['tools', 'catCafeSecretContent'];
export async function apply(ctx) {
 let effects=0;
 ctx.tools.register({name:'publish_probe',description:'fixture',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async args=>{effects++;return args.text;}});
 ctx.tools.register({name:'nested_probe',description:'fixture composite',parameters:{type:'object',properties:{}},
  output:{schema:{type:'boolean'},render:(_args,value)=>[{type:'text',text:String(value)}]},
  execute:async(_args,exec)=>{const inner=await ctx.tools.execute({callId:'inner',parent:exec.token,rootCallId:exec.rootCallId,name:'publish_probe',arguments:{text:${JSON.stringify(key)}},signal:exec.signal});return inner.isError===true;}});
 ctx.on('tools/pre-execute', async()=>({kind:'allow'}));
 const signal=new AbortController().signal;
 const clean=await ctx.tools.execute({callId:'clean',name:'publish_probe',arguments:{text:'clean'},signal});
 const direct=await ctx.tools.execute({callId:'direct',name:'publish_probe',arguments:{text:${JSON.stringify(key)}},signal});
 const nested=await ctx.tools.execute({callId:'outer-ptc',name:'nested_probe',arguments:{},signal});
 writeFileSync(${JSON.stringify(receipt)},JSON.stringify({effects,clean:clean.isError===true,direct:direct.isError,nested:nested.value}));
 ctx.provide('secretFixtureComplete',true);
}`,
    );
    await writeFile(
      patch,
      `- insert:\n    - id: secret-fixture\n      name: ${JSON.stringify(pathToFileURL(fixture).href)}\n- id: acp\n  inject: [acpAppStartup, catCafeSecretContent, secretFixtureComplete]\n`,
    );
    const guarded = await prepareDshSecretPatch('dsh', ['--profile', 'acp'], root);
    const client = new AcpClient({
      command: 'dsh',
      args: [...guarded, '--patch', patch],
      cwd: root,
      inheritParentEnv: false,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        USERPROFILE: root,
        DSH_HOME: join(root, '.dsh'),
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'fixture-local-only',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:59999',
      },
    });
    try {
      const initialized = await client.initialize();
      assert.ok(initialized.protocolVersion);
      assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), {
        effects: 1,
        clean: false,
        direct: true,
        nested: true,
      });
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
