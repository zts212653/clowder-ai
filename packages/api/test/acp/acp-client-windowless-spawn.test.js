import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';

const cwd = resolve('windowless-acp-fixture');
const scenarios = [
  { name: 'plugin', command: join(cwd, 'plugin-agent.exe'), args: ['--stdio', '--scope', 'owner'] },
  { name: 'CodeAgent', command: join(cwd, 'codeagent.exe'), args: ['--acp'] },
  { name: 'DSH', command: process.execPath, args: [join(cwd, 'dsh/lib/bin.js'), '--profile', 'acp'] },
];

for (const scenario of scenarios) {
  test(`ACP hides ${scenario.name} console windows and preserves its launch contract`, async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 0,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.killed = true;
        this.stdout.end();
        this.stderr.end();
        this.emit('exit', 0, null);
        return true;
      },
    });
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      setImmediate(() =>
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } })}\n`),
      );
    });
    const calls = [];
    const env = { ACP_WINDOWLESS_FIXTURE: scenario.name };
    const client = new AcpClient({
      command: scenario.command,
      args: scenario.args,
      cwd,
      env,
      inheritParentEnv: false,
      spawnFn(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    });
    try {
      await client.initialize();
      assert.equal(calls.length, 1);
      const launch = calls[0];
      assert.equal(launch.options.windowsHide, true);
      assert.equal(launch.command, scenario.command);
      assert.deepEqual(launch.args, scenario.args);
      assert.equal(launch.options.cwd, cwd);
      assert.deepEqual(launch.options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(launch.options.env.ACP_WINDOWLESS_FIXTURE, scenario.name);
      assert.equal(launch.options.env.PWD, cwd);
      assert.equal(launch.options.env.INIT_CWD, cwd);
      assert.equal(launch.options.shell, undefined);
      assert.deepEqual(env, { ACP_WINDOWLESS_FIXTURE: scenario.name });
    } finally {
      await client.close();
    }
    assert.equal(child.killed, true);
  });
}
