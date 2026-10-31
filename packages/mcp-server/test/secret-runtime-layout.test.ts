import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const layout of ['standalone', 'node_modules'] as const) {
  test(`built secret runtime works after the MCP package moves outside the source repository (${layout})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-installed-layout-'));
    try {
      const original = join(root, 'original');
      cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(original, 'dist'), { recursive: true });
      writeFileSync(join(original, 'package.json'), '{"type":"module"}');
      const moved =
        layout === 'node_modules' ? join(root, 'moved/node_modules/@cat-cafe/mcp-server') : join(root, 'moved');
      mkdirSync(join(moved, '..'), { recursive: true });
      renameSync(original, moved);
      const result = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { fileURLToPath, pathToFileURL } from 'node:url';
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
      const blocked=await runtime.withSecretToolGuard('publish',{body:token},execute,{...options,outbound:true});
      assert.equal(blocked.isError,true); assert.equal(calls,0); assert.equal(notices,0);
      const local=await runtime.withSecretToolGuard('read_notes',{},execute,{...options,environment:{}});
      assert.equal(calls,1); assert.equal(notices,0); assert.ok(JSON.stringify(local).includes(token));
      const result=await runtime.withSecretToolGuard('read_notes',{},execute,{...options,knownCredentials:[token]});
      assert.equal(calls,2); assert.equal(notices,1); assert.ok(!JSON.stringify(result).includes(token));
      writeFileSync('.env.local','opaque-secret');
      const read=await runtime.withSecretToolGuard('read_file',{path:'.env.local'},async args=>({content:[{type:'text',text:readFileSync(args.path,'utf8')}]}),{...options,environment:{}});
      assert.equal(read.isError,undefined); assert.ok(JSON.stringify(read).includes('opaque-secret'));
      const config=withOpenCodeSecretGuard({mcp:{foreign:{type:'local',command:['node','tool.js']}}},{CAT_CAFE_CALLBACK_TOKEN:'fixture'});
      const plugin=await import(config.plugin[0]);
      const instance=await plugin.SecretContentProtection({directory:process.cwd()});
      await instance.config(config);
      assert.equal(config.plugin.length,1);
      assert.deepEqual(config.mcp.foreign.command,['node','tool.js']);
      assert.equal(existsSync(new URL('dist/secret-mcp-proxy.js',base)),false);
      const callback={CAT_CAFE_API_URL:'http://127.0.0.1:1',CAT_CAFE_INVOCATION_ID:'moved-inv',CAT_CAFE_CALLBACK_TOKEN:['fixture','moved'].join('-')};
      const managed=withOpenCodeSecretGuard({mcp:{collab:{type:'local',command:[process.execPath,fileURLToPath(new URL('dist/collab.js',base))]}}},callback);
      assert.deepEqual(managed.mcp.collab.environment,callback,'a moved installed package still recognizes its own first-party entrypoint');
      for(const name of ['secret-native-hook.mjs','secret-kimi-hook.mjs','secret-dsh-plugin.mjs','agy-native-effect-guard.mjs','guarded-bin/gh','guarded-bin/curl','guarded-zsh/.zshenv']) assert.ok(existsSync(runtime.secretRuntimeScript(name)));
      const program=runtime.secretRuntimeScript('guarded-bin/gh');
      const scoped=spawnSync(process.execPath,[program,'pr','create','--title','verdict(fixture): installation probe','--body','safe fixture'],{encoding:'utf8'});
      assert.equal(scoped.status,1);
      assert.match(scoped.stderr,/verdict_publish_missing_repo_scope/,'packaged command must load deployment defaults before enforcing repository scope');
      assert.doesNotMatch(scoped.stderr,/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
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
}
