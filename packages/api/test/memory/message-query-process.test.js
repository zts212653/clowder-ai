import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { qualificationSpawnDeps } from '../../dist/domains/memory/message-query-native.js';
import { spawnCli } from '../../dist/utils/cli-spawn.js';

const ps = promisify(execFile);

test(
  'qualification cancellation retains the supervisor until separately grouped descendants have exited',
  {
    skip: process.platform === 'win32' ? 'Unix process-group assertion' : false,
  },
  async () => {
    const controller = new AbortController();
    const pids = [];
    const births = new Map();
    const child = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const ids=[];
    for(let i=0;i<3;i++)ids.push(spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'}).pid);
    setTimeout(()=>console.log(JSON.stringify({type:'test-ready',pids:[process.pid,...ids]})),300);
    setInterval(()=>{},1000);`;
    let remaining = [];
    try {
      for await (const event of spawnCli(
        {
          command: process.execPath,
          args: ['-e', child],
          bindExecutionOwner: false,
          signal: controller.signal,
          timeoutMs: 5000,
        },
        qualificationSpawnDeps,
      )) {
        if (event?.type === 'test-ready') {
          pids.push(...event.pids);
          for (const pid of pids) {
            const row = await ps('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
            births.set(pid, row.stdout.trim());
          }
          controller.abort();
        }
      }
      assert.equal(pids.length, 4);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await ps('ps', ['-p', pids.join(','), '-o', 'pid=,stat='], { encoding: 'utf8' }).catch((error) => {
        if (error.code === 1) return { stdout: '' };
        throw error;
      });
      remaining = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim() && !line.includes('Z'));
      assert.deepEqual(remaining, [], 'no live original child may outlast the cancelled invocation');
    } finally {
      // Only children created by this test; retain failed evidence without leaking a fixture.
      for (const pid of pids) {
        try {
          const current = await ps('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
          if (current.stdout.trim() === births.get(pid)) process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH' && error.code !== 1) throw error;
        }
      }
    }
  },
);
