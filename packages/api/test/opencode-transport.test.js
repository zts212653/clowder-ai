import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { probeOpenCodeAutoApproveSupport } from '../dist/domains/cats/services/agents/providers/opencode-auto-approval.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('opencode');

// Real, owned Node children model a shared-service port conflict. No installed
// OpenCode process, account, model endpoint, or user HOME is read by this fixture.
const CLI_SOURCE = `
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
if (args[0] === 'run' && args[1] === '--help') {
  fs.appendFileSync(process.env.OC_FIXTURE_PROBES, 'help\\n');
  if (process.env.OC_FIXTURE_FAIL_ONCE && !fs.existsSync(process.env.OC_FIXTURE_FAILED)) {
    fs.writeFileSync(process.env.OC_FIXTURE_FAILED, 'failed'); process.exit(1);
  }
  console.log(process.env.OC_FIXTURE_HELP); process.exit(0);
}
const emit = event => console.log(JSON.stringify(event));
const finish = () => {
  if (process.env.OC_FIXTURE_TOOLS && !args.includes('--pure')) {
    emit({type:'step_start',sessionID:'fixture-session',part:{type:'step-start'}});
    emit({type:'text',part:{type:'text',text:'working'}});
    emit({type:'tool_use',part:{type:'tool',tool:'read',callID:'fixture',state:{status:'completed',input:{filePath:'fixture'},output:'read'}}});
    emit({type:'step_finish',part:{type:'step-finish',reason:'tool-calls',tokens:{total:1}}});
  } else {
    emit({type:'text',part:{type:'text',text:'42'}});
    emit({type:'step_finish',part:{type:'step-finish',reason:'stop',tokens:{total:1}}});
  }
};
if (!process.env.OC_FIXTURE_PORT) finish();
else {
  const explicitServer = args.some(arg => arg === '--server' || arg.startsWith('--server='));
  const server = net.createServer();
  server.on('error', error => {
    emit({type:'error',error:{type:'service.bind',message:error.code}}); process.exitCode = 1;
  });
  server.listen(args.includes('--standalone') || explicitServer ? 0 : Number(process.env.OC_FIXTURE_PORT), '127.0.0.1', () => {
    finish(); server.close();
  });
}
`;

function fixture(t, { help = '--auto\n--standalone', failOnce = false, port, tools = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-transport-'));
  t.after(() => {
    assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const script = join(root, 'fixture.cjs');
  const command = join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  writeFileSync(script, CLI_SOURCE);
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(command, 0o755);
  const env = {
    OC_FIXTURE_HELP: help,
    OC_FIXTURE_PROBES: join(root, 'probes'),
    OC_FIXTURE_FAILED: join(root, 'failed'),
    ...(failOnce ? { OC_FIXTURE_FAIL_ONCE: '1' } : {}),
    ...(port ? { OC_FIXTURE_PORT: String(port) } : {}),
    ...(tools ? { OC_FIXTURE_TOOLS: '1' } : {}),
  };
  const calls = [];
  const probe = () => probeOpenCodeAutoApproveSupport(command, root, env);
  const service = new OpenCodeAgentService({
    catId: 'opencode-transport-fixture',
    model: 'fixture/unchanged',
    rawArchive: { async append() {} },
    opencodeManagedConfigPaths: [],
    autoApproveProbeFn: probe,
    spawnFn(_command, args, options) {
      calls.push({ args, env: options.env });
      return spawn(process.execPath, [script, ...args], {
        ...options,
        env: { ...options.env, ...env },
        windowsHide: true,
      });
    },
  });
  return {
    service,
    calls,
    probe,
    probeCount: () =>
      existsSync(env.OC_FIXTURE_PROBES) ? readFileSync(env.OC_FIXTURE_PROBES, 'utf8').trim().split('\n').length : 0,
  };
}

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

test('one advertised help probe isolates ordinary runs from an occupied shared-service port', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const { service, calls, probeCount } = fixture(t, { port: occupied.address().port });
  for (let turn = 0; turn < 2; turn++) {
    const messages = await collect(service.invoke('fixture'));
    assert.equal(messages.findLast((message) => message.type === 'text')?.content, '42');
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.ok(calls[turn].args.includes('--standalone'));
    assert.ok(calls[turn].args.includes('--auto'));
    assert.equal(calls[turn].args[calls[turn].args.indexOf('-m') + 1], 'fixture/unchanged');
  }
  assert.equal(probeCount(), 1, 'transport and approval must share one cached help subprocess');
});

test('old help and similarly named flags cannot enable standalone', async (t) => {
  const { service, calls } = fixture(t, { help: '--auto\n--standalone-other' });
  await collect(service.invoke('fixture'));
  assert.equal(calls[0].args.includes('--standalone'), false);
  assert.ok(calls[0].args.includes('--auto'));
});

test('standalone can be discovered even if help has no approval flag', async (t) => {
  const { service, calls, probeCount } = fixture(t, { help: '--standalone' });
  await collect(service.invoke('fixture'));
  assert.ok(calls[0].args.includes('--standalone'));
  assert.equal(calls[0].args.includes('--auto'), false);
  assert.equal(probeCount(), 1);
});

test('failed help is retried on the next invocation, never twice within one invocation', async (t) => {
  const { service, calls, probeCount } = fixture(t, { failOnce: true });
  await collect(service.invoke('fixture'));
  assert.equal(probeCount(), 1);
  assert.equal(calls[0].args.includes('--standalone'), false);
  await collect(service.invoke('fixture'));
  await collect(service.invoke('fixture'));
  assert.equal(probeCount(), 2);
  assert.ok(calls[1].args.includes('--standalone'));
  assert.ok(calls[2].args.includes('--standalone'));
});

for (const transport of [
  ['--server', 'http://127.0.0.1:9876'],
  ['--server=http://127.0.0.1:9876'],
  ['--standalone'],
  ['--standalone=false'],
  ['--no-standalone'],
  ['--standalone', 'false'],
]) {
  test(`explicit transport ${transport[0]} remains authoritative`, async (t) => {
    const { service, calls } = fixture(t);
    await collect(service.invoke('fixture', { cliConfigArgs: [...transport, '--no-auto'] }));
    const args = calls[0].args;
    for (const part of transport) assert.ok(args.includes(part));
    assert.equal(args.filter((arg) => arg === '--standalone').length, transport[0] === '--standalone' ? 1 : 0);
    assert.equal(args.includes('--auto'), false);
  });
}

test('read-only defaults to advertised private transport without injecting approval', async (t) => {
  const { service, calls, probeCount } = fixture(t);
  await collect(service.invoke('fixture', { toolExecutionPolicy: { mode: 'read_only' } }));
  assert.ok(calls[0].args.includes('--standalone'));
  assert.ok(calls[0].args.includes('--pure'));
  assert.equal(calls[0].args.includes('--auto'), false);
  assert.equal(probeCount(), 1);
});

test('read-only preserves private transport but cannot inherit user approval or agent overrides', async (t) => {
  const { service, calls } = fixture(t);
  await collect(
    service.invoke('fixture', {
      toolExecutionPolicy: { mode: 'read_only' },
      cliConfigArgs: ['--standalone', '--auto', '--agent', 'unsafe-user-agent'],
    }),
  );
  const { args, env } = calls[0];
  assert.ok(args.includes('--standalone'));
  assert.ok(args.includes('--pure'));
  assert.equal(args[args.indexOf('--agent') + 1], 'cat-cafe-read-only');
  assert.equal(args.includes('--auto'), false);
  assert.equal(args.includes('unsafe-user-agent'), false);
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission.bash, 'deny');
});

for (const transport of [
  ['--server', 'http://user:fixturePassword@127.0.0.1:9876'],
  ['--server=http://user:fixturePassword@127.0.0.1:9876'],
  ['--standalone=false'],
  ['--no-standalone'],
  ['--standalone', 'false'],
]) {
  test(`read-only rejects unverified shared transport ${transport[0]} before any subprocess`, async (t) => {
    const { service, calls, probeCount } = fixture(t);
    const messages = await collect(
      service.invoke('fixture', { toolExecutionPolicy: { mode: 'read_only' }, cliConfigArgs: transport }),
    );
    assert.match(messages.find((message) => message.type === 'error')?.error ?? '', /cannot verify.*permissions/i);
    assert.doesNotMatch(JSON.stringify(messages), /fixturePassword/);
    assert.equal(calls.length, 0);
    assert.equal(probeCount(), 0);
    assert.equal(messages.at(-1)?.type, 'done');
  });
}

for (const transport of [
  [],
  ['--server', 'http://127.0.0.1:9876'],
  ['--standalone=false'],
  ['--no-standalone'],
  ['--standalone', 'false'],
]) {
  test(`no-tool finalizer ${transport.length ? `refuses shared transport ${transport[0]}` : 'preserves default private transport'}`, async (t) => {
    const { service, calls, probeCount } = fixture(t, { tools: true });
    const messages = await collect(service.invoke('fixture', { cliConfigArgs: transport }));
    if (transport.length) {
      assert.equal(calls.length, 1, 'strict continuation must not assume that another server receives permission env');
      assert.match(
        messages.findLast((message) => message.type === 'text')?.content ?? '',
        /unverified_server_permissions/,
      );
      for (const part of transport) assert.ok(calls[0].args.includes(part), 'ordinary run must keep user transport');
      return;
    }
    assert.equal(messages.findLast((message) => message.type === 'text')?.content, '42');
    assert.equal(calls.length, 2);
    const finalizer = calls[1];
    const expected = transport.length ? transport : ['--standalone'];
    for (const part of expected) assert.ok(finalizer.args.includes(part));
    assert.ok(finalizer.args.includes('--pure'));
    assert.equal(finalizer.args.includes('--auto'), false);
    assert.equal(JSON.parse(finalizer.env.OPENCODE_PERMISSION)['*'], 'deny');
    assert.equal(probeCount(), 1);
  });
}
