import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { nativeRuntimeReadiness } from '../../dist/routes/native-runtime-readiness.js';
import { buildUnixProcessSnapshotArgs } from '../../dist/utils/cli-process-ownership.js';
import { resolveWindowsSpawnPlan } from '../../dist/utils/cli-spawn-win.js';

/** Test-owned binaries and a process guard: no host client can be started. */
export function fakeNativeDiscovery(root, mock) {
  const transcript = join(root, 'fake-native-protocol.jsonl');
  const program = join(root, 'fake-native.cjs');
  writeFileSync(
    program,
    `const fs=require('node:fs');
const mode=process.argv[2], log=${JSON.stringify(transcript)};
const note=value=>fs.appendFileSync(log,JSON.stringify(value)+'\\n');
if(mode==='claude'){
 if(JSON.stringify(process.argv.slice(3))!==JSON.stringify(['auth','status','--json']))process.exit(91);
 note({mode,args:process.argv.slice(3)});console.log(JSON.stringify({loggedIn:true,email:'fixture@example.invalid',access_token:'fake-sensitive-sentinel'}));
}else{
 if(JSON.stringify(process.argv.slice(3))!==JSON.stringify(['app-server']))process.exit(92);
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);note({mode,method:request.method,params:request.params});
  if(request.method==='initialized')return;
  if(!['initialize','account/read'].includes(request.method))process.exit(93);
  if(request.method==='account/read'&&request.params.refreshToken!==false)process.exit(94);
  const result=request.method==='initialize'?{}:{account:{type:'chatgpt',email:'fixture@example.invalid',access_token:'fake-sensitive-sentinel'}};
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
 });
}`,
  );
  const targets = ['codex', 'claude'].map((id) => {
    const command = join(root, `test-${id}${process.platform === 'win32' ? '.cmd' : ''}`);
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@"${process.execPath}" "${program}" ${id} %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath}' '${program}' ${id} "$@"\n`,
    );
    chmodSync(command, 0o755);
    return {
      id,
      label: id === 'codex' ? 'Codex' : 'Claude Code',
      clientId: id === 'codex' ? 'openai' : 'anthropic',
      installed: true,
      command,
      models: [],
    };
  });
  const spawn = childProcess.spawn,
    execFile = childProcess.execFile;
  const plans = targets.map((t) => {
    const args = t.id === 'codex' ? ['app-server'] : ['auth', 'status', '--json'];
    return process.platform === 'win32' ? resolveWindowsSpawnPlan(t.command, args) : { command: t.command, args };
  });
  const permits = (command, args) =>
    plans.some((plan) => plan.command === command && JSON.stringify(plan.args) === JSON.stringify(args));
  const ownedPids = new Set();
  const cleanup = (command, args) =>
    command === join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe') &&
    args[0] === '/PID' &&
    ownedPids.has(Number(args[1])) &&
    JSON.stringify(args.slice(2)) === JSON.stringify(['/T', '/F']);
  const scan = (command, args) =>
    command === '/bin/ps' && JSON.stringify(args) === JSON.stringify(buildUnixProcessSnapshotArgs(true, undefined));
  mock.method(childProcess, 'spawn', (command, args, ...rest) => {
    assert.ok(permits(command, args) || cleanup(command, args), `Uncontrolled spawn blocked: ${command}`);
    const child = spawn(command, args, ...rest);
    if (permits(command, args) && child.pid) ownedPids.add(child.pid);
    return child;
  });
  mock.method(childProcess, 'execFile', (command, args, ...rest) => {
    assert.ok(permits(command, args) || scan(command, args), `Uncontrolled exec blocked: ${command}`);
    return execFile(command, args, ...rest);
  });
  syncBuiltinESMExports();
  return {
    async discover(cwd, refresh) {
      return {
        authenticationStatus: 'local_checked',
        runtimes: await Promise.all(
          targets.map(async (t) => ({ ...t, readiness: await nativeRuntimeReadiness(t, cwd, refresh) })),
        ),
      };
    },
    assertProtocol() {
      const rows = readFileSync(transcript, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(rows.filter((r) => r.mode === 'claude').length, 1);
      assert.deepEqual(
        rows.filter((r) => r.mode === 'codex').map((r) => r.method),
        ['initialize', 'initialized', 'account/read'],
      );
      assert.equal(rows.find((r) => r.method === 'account/read').params.refreshToken, false);
    },
    restore() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}
