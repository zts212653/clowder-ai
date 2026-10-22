import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const profiles = JSON.parse(readFileSync(resolve(root, 'packages/shared/src/deployment-profiles.json'), 'utf8'));
const carrier = resolve(root, '.claude/hooks/f24-compaction.mjs');
const run = String.raw`
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const configUrl=pathToFileURL(process.env.F330_CONFIG_PATH).href;
registerHooks({load(url,context,nextLoad){
 const loaded=nextLoad(url,context);
 if(url!==configUrl)return loaded;
 const config=JSON.parse(String(loaded.source));
 config.activeProfile=process.env.F330_EDITION;
 config.profiles[config.activeProfile].apiPort=45678;
 config.profiles[config.activeProfile].brand.name='Fixture compaction';
 return {...loaded,source:JSON.stringify(config)};
}});
globalThis.fetch=async (url,options)=>{
 process.stdout.write(JSON.stringify({url,headers:options.headers,payload:JSON.parse(options.body)})+'\n');
 return {ok:true,json:async()=>({contextEpoch:{status:'observed'}})};
};
process.argv[2]='pre';
await import(pathToFileURL(process.env.F330_CARRIER).href);
`;

for (const edition of Object.keys(profiles.profiles)) {
  for (const explicitPort of [undefined, '45679']) {
    test(`${edition} managed compaction consumes installed configuration with ${explicitPort ? 'explicit' : 'default'} port`, () => {
      const env = {
        ...process.env,
        CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
        F330_CONFIG_PATH: resolve(root, 'packages/shared/dist/deployment-profiles.json'),
        F330_EDITION: edition,
        F330_CARRIER: carrier,
      };
      delete env.API_SERVER_PORT;
      if (explicitPort) env.API_SERVER_PORT = explicitPort;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', run], {
        cwd: import.meta.dirname, // Deliberately outside the install root.
        env,
        input: JSON.stringify({ session_id: 'fixture-session', trigger: 'manual' }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const [request, response] = result.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(request.url, `http://127.0.0.1:${explicitPort ?? '45678'}/api/sessions/seal`);
      assert.equal(request.headers['X-Clowder-Compaction-Carrier'], 'f296-node-v1');
      assert.equal(request.headers['X-Invocation-Id'], 'fixture-invocation');
      assert.equal(request.headers['X-Callback-Token'], 'fixture-token');
      assert.deepEqual(request.payload, { cliSessionId: 'fixture-session', reason: 'claude-code-compact-manual' });
      assert.equal(response.systemMessage, 'Fixture compaction recorded this invocation context compaction.');
    });
  }
}

test('ordinary CLI sessions remain silent without reading install configuration', () => {
  const env = { ...process.env };
  delete env.CAT_CAFE_INVOCATION_ID;
  delete env.CAT_CAFE_CALLBACK_TOKEN;
  const result = spawnSync(process.execPath, [carrier, 'pre'], { env, input: '{}', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
