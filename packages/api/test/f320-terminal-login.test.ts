import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import { createCodexTerminalLoginDriver } from '../src/config/codex-login-driver.js';

function fixture(keepShell = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "f320-terminal-'; $(touch SHOULD_NOT_EXIST)-")));
  const home = join(root, 'account', 'attempt-home');
  mkdirSync(home, { recursive: true });
  const command = join(root, 'fake codex');
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(process.env.CODEX_HOME,'calls.jsonl'),JSON.stringify({args,home:process.env.CODEX_HOME,envHasKey:!!process.env.OPENAI_API_KEY,issuerOverride:!!process.env.CODEX_APP_SERVER_LOGIN_ISSUER,tty:!!process.stdin.isTTY})+'\\n');
if(args.at(-1)==='status')process.exit(process.env.F320_FAKE_STATUS==='fail'?1:0);
if(process.env.F320_FAKE_LOGIN==='hang'){setInterval(()=>{},1000);}
else if(process.env.F320_FAKE_LOGIN==='fail')process.exit(1);
else {const claims={'https://api.openai.com/auth':{chatgpt_user_id:'fixture-user',chatgpt_account_id:'fixture-account'}};fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{id_token:'x.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.x',account_id:'fixture-account'}}));}
`,
  );
  chmodSync(command, 0o700);
  const starts: string[] = [];
  let terminalShell: ChildProcess | undefined;
  let terminalOutput = '';
  const driver = createCodexTerminalLoginDriver({
    command,
    assertSupport: () => {},
    openTerminal: async (shellCommand) => {
      starts.push(shellCommand);
      const proc = keepShell
        ? spawn('/bin/sh', ['-i'], { cwd: root, stdio: 'pipe' })
        : spawn('/bin/sh', ['-c', shellCommand], { cwd: root, stdio: 'ignore' });
      proc.on('error', () => {});
      if (keepShell) {
        terminalShell = proc;
        proc.stdout?.on('data', (data: Buffer) => {
          terminalOutput += data.toString();
        });
        proc.stderr?.on('data', (data: Buffer) => {
          terminalOutput += data.toString();
        });
        proc.stdin?.on('error', () => {});
        proc.stdin?.write(`${shellCommand}\nprintf ready > terminal-shell-ready\n`);
      }
    },
  });
  const controller = new AbortController();
  let ready = 0;
  const run = () =>
    driver.run({
      home,
      cwd: root,
      signal: controller.signal,
      onReady: () => {
        ready++;
      },
    });
  return {
    root,
    home,
    starts,
    driver,
    controller,
    run,
    ready: () => ready,
    terminalOutput: () => terminalOutput,
    close: () => {
      terminalShell?.stdin?.end('exit\n');
      terminalShell?.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('account login wakes terminal for official login and status in the isolated home, with quoted paths', async () => {
  const saved = process.env.OPENAI_API_KEY;
  const savedIssuer = process.env.CODEX_APP_SERVER_LOGIN_ISSUER;
  process.env.OPENAI_API_KEY = 'ambient-test-secret';
  // A login-issuer knob a later Codex reads; it must not reach the managed login from Terminal's env.
  process.env.CODEX_APP_SERVER_LOGIN_ISSUER = 'https://issuer.invalid';
  const f = fixture();
  try {
    const identity = await f.run();
    assert.deepEqual(identity, { userId: 'fixture-user', workspaceId: 'fixture-account' });
    assert.equal(f.ready(), 1);
    assert.equal(f.starts.length, 1);
    const calls = readFileSync(join(f.home, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.deepEqual(
      calls.map((x) => x.args),
      [
        ['-c', 'cli_auth_credentials_store="file"', 'login'],
        ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
      ],
    );
    assert.ok(calls.every((x) => x.home === f.home && !x.envHasKey));
    assert.ok(calls.every((x) => !x.issuerOverride));
    assert.doesNotMatch(readFileSync(join(dirname(f.home), 'terminal-request.json'), 'utf8'), /ambient-test-secret/);
    assert.equal(readFileSync(join(dirname(f.home), 'terminal-result.json'), 'utf8').includes('id_token'), false);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
    if (savedIssuer === undefined) delete process.env.CODEX_APP_SERVER_LOGIN_ISSUER;
    else process.env.CODEX_APP_SERVER_LOGIN_ISSUER = savedIssuer;
    f.close();
  }
});
test('a failed login returns to the terminal shell so its error remains available', async () => {
  const f = fixture(true);
  process.env.F320_FAKE_LOGIN = 'fail';
  try {
    await assert.rejects(f.run(), /codex_login_failed/);
    const ready = join(f.root, 'terminal-shell-ready');
    for (let i = 0; i < 20 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(ready), true, 'Terminal must retain its shell after the login worker exits');
    assert.match(f.terminalOutput(), /官方 Codex 登录未完成/);
  } finally {
    delete process.env.F320_FAKE_LOGIN;
    f.close();
  }
});
test('an unavailable CLI leaves its launch error in the retained terminal and reports failure', async () => {
  const f = fixture(true);
  rmSync(join(f.root, 'fake codex'));
  try {
    await assert.rejects(f.run(), /codex_login_failed/);
    const ready = join(f.root, 'terminal-shell-ready');
    for (let i = 0; i < 20 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(ready), true);
    assert.match(f.terminalOutput(), /无法启动官方 Codex 命令（ENOENT）/);
    assert.equal(JSON.parse(readFileSync(join(dirname(f.home), 'terminal-result.json'), 'utf8')).exitCode, 1);
  } finally {
    f.close();
  }
});
test('opened terminal and exit-zero without official status do not count as logged in', async () => {
  const f = fixture();
  process.env.F320_FAKE_STATUS = 'fail';
  try {
    await assert.rejects(f.run(), /codex_login_failed/);
  } finally {
    delete process.env.F320_FAKE_STATUS;
    f.close();
  }
});
test('cancel terminates the owned native process and cannot produce success', async () => {
  const f = fixture();
  process.env.F320_FAKE_LOGIN = 'hang';
  try {
    const run = f.run();
    setTimeout(() => f.controller.abort(), 300);
    await assert.rejects(run);
  } finally {
    delete process.env.F320_FAKE_LOGIN;
    f.close();
  }
});

test('official login can open without a Clowder AI callback-port admission', async () => {
  const connection = mock.method(net, 'createConnection', () => {
    const socket = new net.Socket();
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  syncBuiltinESMExports();
  const f = fixture();
  try {
    assert.equal((await f.run()).userId, 'fixture-user');
    assert.equal(connection.mock.callCount(), 0);
    assert.equal(f.starts.length, 1);
  } finally {
    connection.mock.restore();
    syncBuiltinESMExports();
    f.close();
  }
});
