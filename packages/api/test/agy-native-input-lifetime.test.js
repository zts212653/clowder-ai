import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

test('Native keeps stream-json stdin open until the provider terminal, then exits without waiting for timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-input-life-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = 'gemini-3.8-flash-high';
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: process.execPath,
    l0CompilerFn: async () => '# Identity\nNative fixture.',
    profile: {
      enabled: true,
      model,
      profileId: 'gemini38',
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  const script = `
  const readline=require('node:readline');
  const [agent,cwd,model]=process.argv.slice(1);
  const send=(event)=>process.stdout.write(JSON.stringify(event)+'\\n');
  let closed=false;
  process.stdin.on('end',()=>{closed=true;});
  const input=readline.createInterface({input:process.stdin});
  input.once('line',()=>{
   send({event:'init',conversation_id:'stdin-lifetime',init:{agent,cwd,model,permission_mode:'request-review',tools:[]}});
   setTimeout(()=>send({event:'result',result:{conversation_id:'stdin-lifetime',status:closed?'ERROR':'SUCCESS',response:'Reply complete.',...(closed?{error:'stdin closed while this turn was still running'}:{})}}),100);
  });
 `;
  try {
    const messages = [];
    for await (const message of service.invoke('Complete one turn.', {
      workingDirectory: workspace,
      spawnCliOverride: (launch) =>
        spawnCli({
          ...launch,
          command: process.execPath,
          args: ['-e', script, launch.args[launch.args.indexOf('--agent') + 1], launch.cwd, model],
          timeoutMs: 3000,
        }),
    }))
      messages.push(message);
    assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages.filter((m) => m.type === 'error')));
    assert.equal(messages.filter((m) => m.type === 'done').length, 1);
    assert.equal(messages.find((m) => m.type === 'text')?.content, 'Reply complete.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
