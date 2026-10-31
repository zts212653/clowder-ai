import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTmuxAgentCarrierSessionFactory } from '../dist/domains/terminal/tmux-agent-carrier-session.js';
import { spawnCliInTmux } from '../dist/domains/terminal/tmux-agent-spawner.js';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

async function runAgent(gateway, worktreeId, cwd, env) {
  const events = [];
  for await (const event of spawnCliInTmux(
    {
      command: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({allowed:process.env.F212_CALL_SECRET,deleted:process.env.F212_DELETE_ME,hook:process.env.CAT_CAFE_HOOK_TOKEN,pwd:process.env.PWD,initCwd:process.env.INIT_CWD}))',
      ],
      env,
      worktreeId,
      invocationId: randomUUID(),
      cwd,
      outputMode: 'plainText',
      firstEventTimeoutMs: 6000,
      timeoutMs: 6000,
    },
    { tmuxGateway: gateway },
  ))
    events.push(event);
  assert.equal(
    events.some((event) => event.__cliTimeout || event.__cliError),
    false,
  );
  return JSON.parse(events.find((event) => event.__cliPlainText).stdout);
}

function recordTmuxArguments(gateway, dir) {
  const realTmux = gateway.tmuxBin;
  const trace = join(dir, 'argv.jsonl');
  const proxy = join(dir, 'tmux-recorder.cjs');
  writeFileSync(
    proxy,
    `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `const {spawnSync} = require('node:child_process');\n` +
      `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2))+'\\n');\n` +
      `const result = spawnSync(${JSON.stringify(realTmux)}, process.argv.slice(2), {stdio:'inherit'});\n` +
      `process.exit(result.status ?? 1);\n`,
    { mode: 0o700 },
  );
  gateway.tmuxBin = proxy;
  return () =>
    readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
}

function serverEnvironment(gateway, worktreeId, session) {
  return execFileSync(
    gateway.tmuxBin,
    ['-L', gateway.socketName(worktreeId), 'show-environment', ...(session ? ['-t', session] : ['-g'])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

function serverProcessEnvironment(gateway, worktreeId) {
  const pid = execFileSync(gateway.tmuxBin, ['-L', gateway.socketName(worktreeId), 'display-message', '-p', '#{pid}'], {
    encoding: 'utf8',
  }).trim();
  assert.match(pid, /^[1-9]\d*$/);
  return process.platform === 'darwin'
    ? execFileSync('/bin/ps', ['eww', '-p', pid, '-o', 'command='], { encoding: 'utf8' })
    : readFileSync(`/proc/${pid}/environ`, 'utf8');
}

test(
  'real child receives planned invocation values without exposing them in tmux argv',
  { timeout: 15000 },
  async () => {
    const gateway = new TmuxGateway();
    const wt = `test-invocation-env-${randomUUID()}`;
    const dir = mkdtempSync(join(tmpdir(), 'catcafe-env-argv-'));
    const readArguments = recordTmuxArguments(gateway, dir);
    const secret = `F212_SYNTHETIC_${randomUUID()}`;
    const previous = process.env.F212_DELETE_ME;
    process.env.F212_DELETE_ME = 'inherited-delete-control';
    try {
      const observed = await runAgent(gateway, wt, dir, {
        F212_CALL_SECRET: secret,
        F212_DELETE_ME: null,
        CAT_CAFE_HOOK_TOKEN: 'forbidden-override',
        PWD: '/wrong-invocation',
        INIT_CWD: '/wrong-invocation',
      });
      assert.equal(observed.allowed, secret, 'allowed secret must actually reach the child');
      assert.equal(
        readArguments().some((args) => args.some((arg) => arg.includes(secret))),
        false,
        'the actual tmux invocation must never carry the secret value',
      );
      assert.equal(observed.deleted, undefined);
      assert.equal(observed.hook, undefined);
      assert.equal(observed.pwd, dir);
      assert.equal(observed.initCwd, dir);
      assert.equal(serverEnvironment(gateway, wt).includes(secret), false);
    } finally {
      if (previous === undefined) delete process.env.F212_DELETE_ME;
      else process.env.F212_DELETE_ME = previous;
      await gateway.destroyServer(wt);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'the real duplex factory uses the same private invocation environment transport',
  { timeout: 12000 },
  async (t) => {
    const gateway = new TmuxGateway();
    const wt = `test-carrier-env-${randomUUID()}`;
    const dir = mkdtempSync(join(tmpdir(), 'catcafe-carrier-env-'));
    const readArguments = recordTmuxArguments(gateway, dir);
    const secret = `CARRIER_SYNTHETIC_${randomUUID()}`;
    const factory = createTmuxAgentCarrierSessionFactory({ worktreeId: wt, userId: 'test-user', tmuxGateway: gateway });
    let session;
    try {
      session = await factory({
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({type:"env",allowed:process.env.F212_CALL_SECRET,hook:process.env.CAT_CAFE_HOOK_TOKEN}));process.stdin.once("data",()=>process.exit(0))',
        ],
        env: { F212_CALL_SECRET: secret, CAT_CAFE_HOOK_TOKEN: 'forbidden-carrier-override' },
        cwd: dir,
        invocationId: randomUUID(),
        signal: t.signal,
      });
      const reader = session.read()[Symbol.asyncIterator]();
      const event = await reader.next();
      assert.equal(event.value.allowed, secret, 'the real factory child must receive the value');
      assert.equal(event.value.hook, undefined);
      assert.equal(
        readArguments().some((args) => args.some((arg) => arg.includes(secret))),
        false,
      );
      assert.equal(serverEnvironment(gateway, wt).includes(secret), false);
      const completion = reader.next();
      await session.write({ finish: true });
      assert.equal((await completion).done, true);
      await session.close();
    } finally {
      await session?.close().catch(() => {});
      await gateway.destroyServer(wt);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('fresh shared server receives a baseline without API or invocation credentials', { timeout: 15000 }, async () => {
  const gateway = new TmuxGateway();
  const wt = `test-server-baseline-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'catcafe-env-baseline-'));
  const keys = ['CAT_CAFE_HOOK_TOKEN', 'F212_RUNTIME_ACCOUNT'];
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = `SYNTHETIC_${randomUUID()}`;
  const invocationSecret = `INVOCATION_${randomUUID()}`;
  try {
    const observed = await runAgent(gateway, wt, dir, { F212_CALL_SECRET: invocationSecret });
    assert.equal(observed.allowed, invocationSecret);
    const environment = serverEnvironment(gateway, wt);
    const processEnvironment = serverProcessEnvironment(gateway, wt);
    for (const key of keys) {
      assert.equal(environment.includes(`${key}=`), false, `${key} must not reside in server global env`);
      assert.equal(processEnvironment.includes(`${key}=`), false, `${key} must not enter the server process`);
    }
    assert.equal(
      environment.includes(invocationSecret),
      false,
      'the invocation secret must never reside in server env',
    );
    assert.equal(
      processEnvironment.includes(invocationSecret),
      false,
      'the invocation secret must never enter the server process',
    );
    assert.equal(observed.hook, undefined);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await gateway.destroyServer(wt);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'discovered existing server cannot seed the new agent or its shell startup with stale credentials',
  { timeout: 15000 },
  async () => {
    const gateway = new TmuxGateway();
    const wt = `test-discovered-env-${randomUUID()}`;
    const sock = gateway.socketName(wt);
    const dir = mkdtempSync(join(tmpdir(), 'catcafe-env-existing-'));
    const startupMarker = join(dir, 'legacy-shell-started');
    const previousShell = process.env.SHELL;
    writeFileSync(join(dir, '.zshenv'), `printf legacy > '${startupMarker}'\n`);
    const legacyEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      SHELL: '/bin/sh',
      CAT_CAFE_HOOK_TOKEN: 'synthetic-existing-bearer',
      F212_LEGACY_ACCOUNT: 'synthetic-existing-account',
      ZDOTDIR: dir,
    };
    execFileSync(gateway.tmuxBin, ['-L', sock, 'new-session', '-d', '-s', 'legacy', '/bin/sh'], {
      env: legacyEnv,
      stdio: 'ignore',
    });
    const originalPane = (await gateway.listPanes(wt))[0];
    process.env.SHELL = '/bin/zsh';
    try {
      await gateway.ensureServer(wt);
      await runAgent(gateway, wt, dir, {});
      assert.equal(
        existsSync(startupMarker),
        false,
        'legacy shell rc must not execute before invocation environment is established',
      );
      for (const environment of [serverEnvironment(gateway, wt), serverEnvironment(gateway, wt, 'legacy')]) {
        assert.equal(
          environment.includes('CAT_CAFE_HOOK_TOKEN='),
          false,
          'discovered server environment must be clean',
        );
        assert.equal(
          environment.includes('F212_LEGACY_ACCOUNT='),
          false,
          'discovered server environment must be clean',
        );
      }
      const retained = (await gateway.listPanes(wt)).find((pane) => pane.paneId === originalPane.paneId);
      assert.equal(retained?.panePid, originalPane.panePid, 'running legacy work must remain intact');
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      await gateway.destroyServer(wt);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
