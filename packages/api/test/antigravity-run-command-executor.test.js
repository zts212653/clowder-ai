import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { AuditLogger } from '../dist/domains/cats/services/agents/providers/antigravity/executors/AuditLogger.js';
import { RunCommandExecutor } from '../dist/domains/cats/services/agents/providers/antigravity/executors/RunCommandExecutor.js';

describe('RunCommandExecutor', () => {
  let logDir;
  let audit;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-run-'));
    audit = new AuditLogger(logDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {}
  });

  const ctx = (overrides = {}) => ({
    cascadeId: 'c1',
    trajectoryId: 't1',
    stepIndex: 0,
    cwd: '/tmp',
    audit,
    ...overrides,
  });

  test('calls rpc with RunCommand and returns stdout/exitCode on success', async () => {
    const rpc = mock.fn(async () => ({ stdout: 'hi\n', stderr: '', exitCode: 0 }));
    const exec = new RunCommandExecutor({ rpc });
    const result = await exec.execute({ commandLine: 'echo hi', cwd: '/tmp' }, ctx());
    assert.equal(result.status, 'success');
    assert.equal(result.stdout, 'hi\n');
    assert.equal(result.exitCode, 0);
    assert.equal(rpc.mock.callCount(), 1);
    const [method, payload] = rpc.mock.calls[0].arguments;
    assert.equal(method, 'RunCommand');
    assert.equal(payload.cwd, '/tmp');
    assert.match(payload.args?.join(' ') ?? '', /echo hi/);
  });

  test('refuses Redis 6399 touches', async () => {
    const rpc = mock.fn();
    const exec = new RunCommandExecutor({ rpc });
    const result = await exec.execute({ commandLine: 'redis-cli -p 6399 flushall', cwd: '/tmp' }, ctx());
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /6399/);
    assert.equal(rpc.mock.callCount(), 0);
  });

  test('refuses all Redis 6399 targeting syntaxes (not just -p 6399)', async () => {
    const rpc = mock.fn();
    const exec = new RunCommandExecutor({ rpc });
    const variants = [
      'redis-cli -p 6399 ping',
      'redis-cli --port 6399 ping',
      'redis-cli --port=6399 ping',
      'redis-cli -u redis://localhost:6399/0 flushall',
      'redis-cli -u rediss://localhost:6399 ping',
      'redis-cli -u redis://:pwd@127.0.0.1:6399/0',
      'REDIS_URL=redis://localhost:6399 node script.js',
      'REDIS_URL=redis://:p@host:6399/0 pnpm start',
      'redis-cli -h 127.0.0.1 -p 6399',
      'node -e "require(\'ioredis\').createClient({port:6399})"',
    ];
    for (const cmd of variants) {
      const result = await exec.execute({ commandLine: cmd, cwd: '/tmp' }, ctx());
      assert.equal(result.status, 'refused', `should refuse: ${cmd}`);
      assert.match(result.reason, /6399/, `reason should mention 6399: ${cmd}`);
    }
    assert.equal(rpc.mock.callCount(), 0);
  });

  test('allows non-6399 Redis operations (6398 dev Redis)', async () => {
    const rpc = mock.fn(async () => ({ stdout: 'PONG', stderr: '', exitCode: 0 }));
    const exec = new RunCommandExecutor({ rpc });
    const allowed = [
      'redis-cli -p 6398 ping',
      'redis-cli --port 6398 ping',
      'REDIS_URL=redis://localhost:6398 node script.js',
    ];
    for (const cmd of allowed) {
      const result = await exec.execute({ commandLine: cmd, cwd: '/tmp' }, ctx());
      assert.equal(result.status, 'success', `should allow: ${cmd}`);
    }
    assert.equal(rpc.mock.callCount(), allowed.length);
  });

  test('refuses rm -rf /', async () => {
    const rpc = mock.fn();
    const exec = new RunCommandExecutor({ rpc });
    const result = await exec.execute({ commandLine: 'rm -rf /', cwd: '/tmp' }, ctx());
    assert.equal(result.status, 'refused');
    assert.equal(rpc.mock.callCount(), 0);
  });

  test('returns error status on rpc failure', async () => {
    const rpc = mock.fn(async () => {
      throw new Error('RPC boom');
    });
    const exec = new RunCommandExecutor({ rpc });
    const result = await exec.execute({ commandLine: 'echo hi', cwd: '/tmp' }, ctx());
    assert.equal(result.status, 'error');
    assert.match(result.error, /RPC boom/);
  });

  test('audits every execution (success, refused, error)', async () => {
    const rpc = mock.fn(async () => ({ stdout: 'ok', exitCode: 0 }));
    const exec = new RunCommandExecutor({ rpc });

    await exec.execute({ commandLine: 'echo ok', cwd: '/tmp' }, ctx());
    await exec.execute({ commandLine: 'rm -rf /', cwd: '/tmp' }, ctx());

    const rpcErr = mock.fn(async () => {
      throw new Error('down');
    });
    await new RunCommandExecutor({ rpc: rpcErr }).execute({ commandLine: 'x', cwd: '/tmp' }, ctx());

    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    const lines = fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].result.status, 'success');
    assert.equal(parsed[1].result.status, 'refused');
    assert.equal(parsed[2].result.status, 'error');
  });

  test('canHandle returns true for run_command tool step', () => {
    const exec = new RunCommandExecutor({ rpc: mock.fn() });
    assert.equal(exec.canHandle({ metadata: { toolCall: { name: 'run_command' } } }), true);
    assert.equal(exec.canHandle({ toolCall: { toolName: 'run_command' } }), true);
    assert.equal(exec.canHandle({ metadata: { toolCall: { name: 'read_file' } } }), false);
  });

  test('toolName is run_command', () => {
    const exec = new RunCommandExecutor({ rpc: mock.fn() });
    assert.equal(exec.toolName, 'run_command');
  });
});
