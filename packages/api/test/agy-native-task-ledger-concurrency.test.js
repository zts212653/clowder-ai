import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordApprovedAgyCommand, resolveBoundCommandTask } from '../../../scripts/agy-native-task-ledger.mjs';
import { buildAgyDataReceiverCommand } from '../../../scripts/lib/agy-data-input-contract.mjs';

const guardUrl = new URL('../../../scripts/agy-native-effect-guard.mjs', import.meta.url).href;
const worker = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const config=JSON.parse(process.argv[1]);
const read=fs.readFileSync;
let armed=true;
fs.readFileSync=function(path,...args) {
 const value=read(path,...args);
 if(armed&&String(path)===config.oldLedger) {
  armed=false;fs.writeFileSync(config.ready+'/'+config.index,'ready');
  const end=Date.now()+3000;
  while(fs.readdirSync(config.ready).length<config.count&&Date.now()<end)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
 }
 return value;
};
syncBuiltinESMExports();
const {decideAgyNativeHookPayload}=await import(config.guard);
process.send('ready');
process.once('message',()=>{
 const payload={conversationId:'parallel',stepIdx:config.index,
   workspacePaths:[config.root],toolCall:{id:'call-'+config.index,name:'run_command',args:{CommandLine:config.command}}};
 const options={profileHome:config.profile,workspaceRoot:config.root};
 const verdict=decideAgyNativeHookPayload(payload,options);
 decideAgyNativeHookPayload({...payload,hookEventName:'PostToolUse',output:'task id: parallel/task-'+config.index},options);
 process.stdout.write(JSON.stringify({index:config.index,verdict}));process.disconnect();
});
`;

for (const count of [2, 20])
  test(
    `${count} independent hook processes preserve each approved command and exact task binding`,
    {
      timeout: 20000,
      skip: !buildAgyDataReceiverCommand(),
    },
    async (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-ledger-parallel-')));
      const profile = join(root, 'profile');
      const ready = join(root, 'ready');
      const children = [];
      t.after(async () => {
        await Promise.all(
          children.map(async ({ child, closed }) => {
            if (child.exitCode === null) child.kill('SIGKILL');
            await closed;
          }),
        );
        rmSync(root, { recursive: true, force: true });
      });
      mkdirSync(join(profile, '.gemini/config'), { recursive: true });
      mkdirSync(ready);
      const command = buildAgyDataReceiverCommand();
      recordApprovedAgyCommand({ conversationId: 'seed', stepIdx: 0 }, root, command, { profileHome: profile });
      const readySignals = [];
      for (let index = 0; index < count; index++) {
        const config = {
          root,
          profile,
          ready,
          index,
          count,
          command,
          guard: guardUrl,
          oldLedger: join(profile, '.gemini/config/.cat-cafe-command-ledger.json'),
        };
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify(config)], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        const closed = once(child, 'close');
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        children.push({ child, closed, result: () => ({ stdout, stderr }) });
        readySignals.push(once(child, 'message'));
      }
      await Promise.all(readySignals);
      for (const { child } of children) child.send('go');
      const outputs = [];
      for (const entry of children) {
        assert.equal((await entry.closed)[0], 0, entry.result().stderr);
        outputs.push(JSON.parse(entry.result().stdout));
      }
      for (const { index } of outputs) {
        const bound = resolveBoundCommandTask({ conversationId: 'parallel' }, 'parallel/task-' + index, {
          profileHome: profile,
        });
        assert.equal(bound.ok, true, `concurrent post-hook lost call-${index}: ${JSON.stringify(bound)}`);
        assert.equal(bound.entry.callId, 'call-' + index);
      }
      const transcriptPath = join(root, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        outputs
          .map(({ index, verdict }) => {
            assert.equal(verdict.decision, 'allow');
            return JSON.stringify({
              step_index: index,
              source: 'MODEL',
              type: 'GENERIC',
              status: 'RUNNING',
              content:
                'task id: parallel/task-' +
                index +
                '\nTask Description: ' +
                verdict.overwrite.CommandLine +
                '\nTask logs are available at: file:///fixture/task.log\n',
            });
          })
          .join('\n'),
      );
      for (const { index } of outputs) {
        const bound = resolveBoundCommandTask(
          { conversationId: 'parallel', transcriptPath },
          'parallel/task-' + index,
          { profileHome: profile },
        );
        assert.equal(bound.ok, true, `approved call-${index} was lost: ${JSON.stringify(bound)}`);
        assert.equal(bound.entry.callId, 'call-' + index);
        assert.equal(bound.entry.stepIdx, index);
        assert.ok(bound.entry.dataInputContract);
      }
      assert.equal(
        resolveBoundCommandTask({ conversationId: 'parallel', transcriptPath }, 'parallel/forged', {
          profileHome: profile,
        }).ok,
        false,
      );
    },
  );
