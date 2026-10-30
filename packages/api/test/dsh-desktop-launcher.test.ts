import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { AcpClient } from '../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { dumpDshConfig, resolveDshSetupLaunch } from '../src/routes/dsh-setup-launch.js';
import { catalogRpc } from '../src/routes/runtime-catalog-rpc.js';
import { resolveWindowsSpawnPlan } from '../src/utils/cli-spawn-win.js';

const official =
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\nexit /b %errorlevel%\r\n';

test(
  'official Desktop ACP launcher preserves Electron ASAR semantics for diagnostics, catalog and real ACP cold spawn',
  { skip: process.platform !== 'win32', timeout: 90_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-launcher-'));
    const install = join(root, 'Desktop 中文 with spaces');
    t.after(() => {
      // Only this test's synthetic program payload is disposable. Keep HOME,
      // snapshots and receipts outside it; no native client state is copied.
      if (dirname(resolve(install)) !== resolve(root) || lstatSync(install).isSymbolicLink())
        throw Error('fixture_boundary_changed');
      rmSync(install, { recursive: true, force: true, maxRetries: 3 });
    });
    const bin = join(install, 'resources/runtime/cli/bin');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, 'dsh.cmd');
    writeFileSync(command, official);
    const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
    const electron = require('electron') as string;
    copyFileSync(electron, join(install, 'DeepSeek Harness.exe'));
    for (const file of ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'])
      copyFileSync(join(dirname(electron), file), join(install, file));
    const payload = join(root, 'payload');
    const entry = join(payload, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(
      entry,
      `
if (process.env.ELECTRON_RUN_AS_NODE !== '1' || !process.execPath.endsWith('DeepSeek Harness.exe')) throw Error('wrong runtime');
if (process.argv.includes('--dump-config')) process.stdout.write('- id: acp\\n  config: {provider: fixture, model: fixture}\\n');
else require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line); if (!req.id) return;
 const result=req.method==='initialize'?{protocolVersion:1,agentCapabilities:{}}:req.method==='session/new'?{sessionId:'desktop-fixture'}:{stopReason:'end_turn'};
 if(req.method==='session/prompt')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:req.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'DESKTOP_ACP_OK'}}}})+'\\n');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});`,
    );
    await (
      require('@electron/asar') as { createPackage: (source: string, target: string) => Promise<void> }
    ).createPackage(payload, join(install, 'resources/app.asar'));
    const parent = process.env.ELECTRON_RUN_AS_NODE;
    const home = join(root, 'home');
    mkdirSync(home);
    const oldHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    t.after(() => {
      if (oldHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = oldHome;
    });
    const args = ['--profile', 'acp'];
    const plan = resolveWindowsSpawnPlan(command, args);
    assert.equal(plan.command, join(install, 'DeepSeek Harness.exe'));
    assert.equal(plan.shell, undefined);
    assert.equal(plan.env?.ELECTRON_RUN_AS_NODE, '1');
    assert.ok(plan.args[1]?.includes('app.asar'));
    const smoke = execFileSync(plan.command, ['-p', 'process.versions.node'], {
      env: { ...process.env, ...plan.env },
      windowsHide: true,
      encoding: 'utf8',
    });
    assert.match(smoke, /^\d+\./);
    const launch = resolveDshSetupLaunch(command, args, root);
    assert.equal(launch.command, command, 'persist the native public command, revalidate it on each cold start');
    assert.match(await dumpDshConfig(launch), /provider: fixture/);
    const rpc = catalogRpc(command, args, root);
    try {
      await rpc.request('initialize', { protocolVersion: 1 });
      assert.deepEqual(await rpc.request('session/new', { cwd: root, mcpServers: [] }), {
        sessionId: 'desktop-fixture',
      });
    } finally {
      await rpc.close();
    }
    const client = new AcpClient({ command, args, cwd: root });
    try {
      await client.initialize();
      const session = await client.newSession(root, []);
      const answer = await client.promptCollect(session.sessionId, 'fixture');
      assert.equal(answer.stopReason, 'end_turn');
      assert.match(JSON.stringify(answer.events), /DESKTOP_ACP_OK/);
    } finally {
      await client.close();
    }
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, parent, 'only the DSH child receives Electron node mode');
    assert.equal(readFileSync(command, 'utf8'), official);
    for (const invalid of [
      official.replace('setlocal DisableDelayedExpansion', 'set "DSH_HOME=C:\\elsewhere"'),
      `${official}\r\necho injected\r\n`,
    ]) {
      writeFileSync(command, invalid);
      assert.throws(() => resolveDshSetupLaunch(command, args, root), /custom_startup/);
      assert.notEqual(resolveWindowsSpawnPlan(command, args).env?.ELECTRON_RUN_AS_NODE, '1');
    }
  },
);
