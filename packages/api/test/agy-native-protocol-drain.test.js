import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Regression from Sol6.1's independent PR #5583 R2 process-lifetime counterexample.
const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { spawnCli } = await import('../dist/utils/cli-spawn.js');
const collect = async (stream) => {
  const events = [];
  for await (const e of stream) events.push(e);
  return events;
};

for (const startup of ['wrong-model-init', 'step-before-init'])
  test(`${startup}: startup ownership must remain until the real child stops doing work`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'f325-review-init-drain-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const pidFile = join(root, 'pid');
    const heartbeat = join(root, 'heartbeat');
    const childScript = join(root, 'provider.cjs');
    writeFileSync(
      childScript,
      `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(process.argv[3], String(process.pid));
let n = 0;
setInterval(() => { fs.writeFileSync(process.argv[4] + '.next', String(++n)); fs.renameSync(process.argv[4] + '.next', process.argv[4]); }, 10);
process.stdout.write(process.argv[2] + '\\n');
setTimeout(() => process.exit(0), 3500);
`,
    );
    const service = new AgyNativeAgentService({
      catId: 'gemini38',
      command: '/usr/bin/true',
      profile: {
        enabled: true,
        profileId: 'gemini38',
        homeRoot: join(root, 'profiles'),
        model: 'gemini-3.8-flash-high',
        trustedWorkspaces: [workspace],
      },
      l0CompilerFn: async () => '# Identity\nDrain fixture.\n',
    });
    let pid;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const started = Date.now();
    let observation;
    try {
      const first = await collect(
        service.invoke('first', {
          workingDirectory: workspace,
          spawnCliOverride: (launch) => {
            const event =
              startup === 'wrong-model-init'
                ? {
                    event: 'init',
                    conversation_id: 'bad-init',
                    init: {
                      cwd: launch.cwd,
                      agent: launch.args[launch.args.indexOf('--agent') + 1],
                      model: 'wrong-model',
                      permission_mode: 'request-review',
                      tools: [],
                    },
                  }
                : {
                    event: 'step_update',
                    step_update: {
                      conversation_id: 'never-initialized',
                      step_index: 1,
                      state: 'ACTIVE',
                      step_type: 'tool',
                      tool_name: 'view_file',
                      tool_info: { output: 'fixture' },
                    },
                  };
            return spawnCli({
              ...launch,
              command: process.execPath,
              args: [childScript, JSON.stringify(event), pidFile, heartbeat],
              timeoutMs: 5000,
            });
          },
        }),
      );
      assert.ok(first.some((e) => e.type === 'error'));
      pid = Number(readFileSync(pidFile, 'utf8'));
      let liveAtNextStart = false;
      let heartbeatAdvanced = false;
      const second = await collect(
        service.invoke('successor', {
          workingDirectory: workspace,
          spawnCliOverride: async function* (launch) {
            liveAtNextStart = alive();
            const prior = existsSync(heartbeat) ? Number(readFileSync(heartbeat, 'utf8')) : 0;
            await delay(100);
            const later = existsSync(heartbeat) ? Number(readFileSync(heartbeat, 'utf8')) : 0;
            heartbeatAdvanced = later > prior;
            yield {
              event: 'init',
              conversation_id: 'successor',
              init: {
                cwd: launch.cwd,
                agent: launch.args[launch.args.indexOf('--agent') + 1],
                model: 'gemini-3.8-flash-high',
                permission_mode: 'request-review',
                tools: [],
              },
            };
            yield {
              event: 'result',
              result: { conversation_id: 'successor', status: 'SUCCESS', response: 'Done', num_turns: 1 },
            };
          },
        }),
      );
      assert.equal(second.at(-1).errorCode, undefined);
      observation = {
        startup,
        firstError: first.find((e) => e.type === 'error')?.error,
        successorObservationMs: Date.now() - started,
        childPid: pid,
        liveAtNextStart,
        heartbeatAdvanced,
      };
      console.log(JSON.stringify(observation));
      assert.equal(
        liveAtNextStart && heartbeatAdvanced,
        false,
        'successor started while the rejected provider was still actively writing',
      );
    } finally {
      if (pid && alive()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      for (let i = 0; pid && alive() && i < 40; i++) await delay(25);
      assert.ok(!pid || !alive(), 'owned fixture child must be reaped');
      rmSync(root, { recursive: true, force: true });
    }
  });
