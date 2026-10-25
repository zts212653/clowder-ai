import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('built secret runtime works after the MCP package moves outside the source repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'secret-installed-layout-'));
  try {
    const original = join(root, 'original');
    cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(original, 'dist'), { recursive: true });
    writeFileSync(join(original, 'package.json'), '{"type":"module"}');
    const moved = join(root, 'moved');
    renameSync(original, moved);
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { existsSync, writeFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const base=pathToFileURL(process.cwd()+'/');
      const runtime=await import(new URL('dist/secret-runtime.js',base));
      const {withOpenCodeSecretGuard}=await import(new URL('dist/secret-opencode-config.js',base));
      const token=['ghp','_','J'.repeat(36)].join('');
      assert.ok(!JSON.stringify(runtime.inspectSecretValue({content:token})).includes(token));
      let calls=0, notices=0;
      const execute=async()=>{calls++; return {content:[{type:'text',text:token}]};};
      const options={callId:'moved',cwd:process.cwd(),notify:async(notice)=>{
        notices++; assert.equal(notice.state,'exposed_or_suspected');
        assert.ok(!JSON.stringify(notice).includes(token));
      }};
      const blocked=await runtime.withSecretToolGuard('publish',{body:token},execute,options);
      assert.equal(blocked.isError,true); assert.equal(calls,0); assert.equal(notices,0);
      const result=await runtime.withSecretToolGuard('read_notes',{},execute,options);
      assert.equal(calls,1); assert.equal(notices,1); assert.ok(!JSON.stringify(result).includes(token));
      writeFileSync('.env.local','opaque-secret');
      const {credentialReadDenial}=await import(new URL('dist/secret-credential-source.js',base));
      assert.match(await credentialReadDenial(process.cwd()+'/.env.local'),/blocked_before_read/);
      const config=withOpenCodeSecretGuard({mcp:{foreign:{type:'local',command:['node','tool.js']}}},{CAT_CAFE_CALLBACK_TOKEN:'fixture'});
      const plugin=await import(config.plugin[0]);
      const instance=await plugin.SecretContentProtection({directory:process.cwd()});
      await instance.config(config);
      assert.equal(config.plugin.length,1);
      assert.equal(config.mcp.foreign.command[1],runtime.secretMcpProxyPath());
      for(const name of ['secret-native-hook.mjs','secret-kimi-hook.mjs','secret-dsh-plugin.mjs','agy-native-effect-guard.mjs','guarded-bin/gh','guarded-bin/curl','guarded-zsh/.zshenv']) assert.ok(existsSync(runtime.secretRuntimeScript(name)));
      console.log(JSON.stringify({blocked:true,redacted:true,notices,plugin:true}));
    `,
      ],
      {
        cwd: moved,
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          HOME: root,
          USERPROFILE: root,
          CAT_CAFE_GUARD_NODE: process.execPath,
          NODE_PATH: '',
        },
        encoding: 'utf8',
      },
    );
    assert.deepEqual(JSON.parse(result), { blocked: true, redacted: true, notices: 1, plugin: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
