/** Deterministic scheduling around real Git, with only fixture-owned child processes. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git, SOURCE } from './worktree-finish-fixture.mjs';
import { requireNativeIdentity, requireSocketScope } from './worktree-fsmonitor-identity.mjs';
import { processRefs } from './worktree-reaper-probes.mjs';

/** A fresh real finish process; only its explicitly supplied environment differs. */
export function finishInEnvironment(f, environment) {
  const module = fileURLToPath(new URL('../worktree-finish.mjs', import.meta.url));
  const opts = {
    repo: f.fx.repo,
    path: f.path,
    owner: 'codex61-sol',
    sourceRef: SOURCE,
    dataRoot: join(f.fx.root, 'data'),
  };
  const script = `import {finishWorktree} from ${JSON.stringify(module)}; try {console.log(JSON.stringify(finishWorktree(${JSON.stringify(opts)})));} catch(error) {console.error(error.message);process.exitCode=1;}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.fx.repo,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 90000, // The complete release includes process observations and archive I/O, beyond native stop.
  });
  const error = result.error ? `${result.error.code}: ${result.error.message}` : result.stderr;
  return {
    code: result.status,
    error,
    signal: result.signal,
    receipt: result.status === 0 ? JSON.parse(result.stdout) : null,
  };
}

async function waitForMonitor(path, dir) {
  const scope = requireSocketScope({ path }, dir, lstatSync(join(dir, 'fsmonitor--daemon.ipc')));
  const probe = `use Socket qw(AF_UNIX SOCK_STREAM sockaddr_un); socket(my $s,AF_UNIX,SOCK_STREAM,0) or die $!; connect($s,sockaddr_un('fsmonitor--daemon.ipc')) or die $!; print unpack('i',getsockopt($s,0,2));`;
  const deadline = Date.now() + 5000;
  for (;;) {
    const pid = Number(execFileSync('/usr/bin/perl', ['-e', probe], { cwd: dir, encoding: 'utf8' }));
    const refs = processRefs({ excludePids: [process.pid], observerPid: process.pid });
    try {
      requireNativeIdentity({ path }, dir, pid, refs, scope.executable);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function failureEnvironment(root, { skipValidator, denyFlock, pauseControl, collideControl }) {
  const skip = join(root, 'skip-validator.cjs');
  if (skipValidator)
    writeFileSync(skip, "if(process.argv[1]?.endsWith('worktree-fsmonitor-admission.mjs')) process.exit(0);\n");
  if (denyFlock)
    writeFileSync(
      join(root, 'FinishFlockFailure.pm'),
      'package FinishFlockFailure; INIT { exit 2 unless @ARGV; } 1;\n',
    );
  if (pauseControl) {
    assert.ok(['mkdir', 'sysopen', 'bind', 'link'].includes(pauseControl));
    const call =
      pauseControl === 'sysopen' ? 'CORE::sysopen($_[0],$_[1],$_[2],$_[3])' : `CORE::${pauseControl}($_[0],$_[1])`;
    const prototype = { mkdir: '$;$', sysopen: '*$$;$', bind: '*$', link: '$$' }[pauseControl];
    writeFileSync(
      join(root, 'FinishControlPause.pm'),
      `package FinishControlPause;
BEGIN { *CORE::GLOBAL::${pauseControl} = sub (${prototype}) { my $ok=${call};
if ($ok && $0 =~ /worktree-fsmonitor-stop[.]pl$/) {
 my $pending="$ENV{TEST_AT_COMMAND}.$$";
 open(my $m,'>', $pending) or die $!; print $m "$$"; close $m;
 rename($pending,$ENV{TEST_AT_COMMAND}) or die $!;
 select(undef,undef,undef,0.01) until -e $ENV{TEST_PROCEED};
} return $ok; }; } 1;\n`,
    );
  }
  const collision = join(root, 'colliding-control');
  if (collideControl)
    writeFileSync(
      join(root, 'FinishControlCollision.pm'),
      `package FinishControlCollision;
BEGIN { *CORE::GLOBAL::mkdir = sub ($;$) {
 if ($0 =~ /worktree-fsmonitor-stop[.]pl$/) {
  CORE::mkdir($_[0],$_[1]) or die $!;
  open(my $m,'>', $ENV{TEST_COLLISION}) or die $!; print $m $_[0]; close $m;
 }
 return CORE::mkdir($_[0],$_[1]); }; } 1;\n`,
    );

  return {
    ...(skipValidator ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${skip}` } : {}),
    ...(denyFlock ? { PERL5LIB: root, PERL5OPT: '-MFinishFlockFailure' } : {}),
    ...(pauseControl ? { PERL5LIB: root, PERL5OPT: '-MFinishControlPause' } : {}),
    ...(collideControl ? { PERL5LIB: root, PERL5OPT: '-MFinishControlCollision', TEST_COLLISION: collision } : {}),
  };
}

async function waitForCommand(finish, { fileSizeLimit, marker, errors }) {
  // Reaching the scheduling boundary includes complete release probes and archive I/O.
  // This observer budget is separate from the unchanged native helper's stop deadlines.
  const deadline = Date.now() + 45000;
  while (fileSizeLimit !== undefined ? finish.exitCode === null && finish.signalCode === null : !existsSync(marker)) {
    if (fileSizeLimit === undefined)
      assert.equal(
        finish.exitCode,
        null,
        existsSync(errors) ? readFileSync(errors, 'utf8') : 'finish exited before scheduled command',
      );
    assert.ok(Date.now() < deadline, 'native scheduling deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function scheduledFinish(
  stage,
  action,
  nativeExit = '',
  {
    skipValidator = false,
    denyFlock = false,
    noDaemon = false,
    fileSizeLimit,
    pauseControl,
    collideControl = false,
  } = {},
) {
  const fx = fixture();
  const path = fx.make();
  const dir = git(path, 'rev-parse', '--absolute-git-dir').trim();
  const marker = join(fx.root, 'at-command');
  const proceed = join(fx.root, 'proceed');
  const output = join(fx.root, 'result.json');
  const errors = join(fx.root, 'error.txt');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const module = fileURLToPath(new URL('../worktree-finish.mjs', import.meta.url));
  const children = [];
  const socket = join(dir, 'fsmonitor--daemon.ipc');
  const journal = () =>
    readFileSync(`${socket}.lock`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  try {
    git(path, 'config', '--worktree', 'core.fsmonitor', 'true');
    if (!noDaemon) {
      git(path, 'fsmonitor--daemon', 'start');
      await waitForMonitor(path, dir); // The scheduling experiment starts only after its real native subject is identified.
    }
    const bin = join(fx.root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/usr/bin/env python3
import os,sys,time
args=sys.argv[1:]; stage=os.environ['TEST_STAGE']
matches=('fsmonitor--daemon' in args and args[-1]==stage) or (stage=='remove' and 'worktree' in args and 'remove' in args)
if matches:
 open(os.environ['TEST_AT_COMMAND'],'w').write('ready')
 deadline=time.monotonic()+15
 while not os.path.exists(os.environ['TEST_PROCEED']) and time.monotonic()<deadline: time.sleep(.01)
 if os.environ['TEST_NATIVE_EXIT']: sys.exit(int(os.environ['TEST_NATIVE_EXIT']))
os.execv(os.environ['TEST_REAL_GIT'],[os.environ['TEST_REAL_GIT']]+args)
`,
      { mode: 0o700 },
    );
    const failureEnv = failureEnvironment(fx.root, { skipValidator, denyFlock, pauseControl, collideControl });
    const collision = failureEnv.TEST_COLLISION;
    const nodeArgs = [
      '--input-type=module',
      '-e',
      `import {writeFileSync} from 'node:fs'; import {finishWorktree} from ${JSON.stringify(module)};
try { const receipt=finishWorktree(${JSON.stringify({ repo: fx.repo, path, owner: 'codex61-sol', sourceRef: 'task:work:finish-fixture', dataRoot: join(fx.root, 'data') })}); writeFileSync(${JSON.stringify(output)},JSON.stringify(receipt)); }
catch(error){ writeFileSync(${JSON.stringify(errors)},String(error)); process.exitCode=1; }`,
    ];
    const finish = spawn(
      fileSizeLimit === undefined ? process.execPath : 'python3',
      fileSizeLimit === undefined
        ? nodeArgs
        : [
            '-I',
            '-S',
            '-c',
            'import os,resource,signal,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(int(sys.argv[1]),int(sys.argv[1]))); signal.signal(signal.SIGXFSZ,signal.SIG_IGN); os.execv(sys.argv[2],sys.argv[2:])',
            String(fileSizeLimit),
            process.execPath,
            ...nodeArgs,
          ],
      {
        cwd: fx.repo,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_STAGE: stage,
          TEST_REAL_GIT: realGit,
          TEST_AT_COMMAND: marker,
          TEST_PROCEED: proceed,
          TEST_NATIVE_EXIT: String(nativeExit),
          ...failureEnv,
        },
        stdio: 'ignore',
      },
    );
    children.push(finish);
    await waitForCommand(finish, { fileSizeLimit, marker, errors });
    const startClient = async () => {
      const client = spawn(
        'python3',
        [
          '-I',
          '-S',
          '-c',
          `import os,socket,sys
s=socket.socket(socket.AF_UNIX)
try:
 s.connect('fsmonitor--daemon.ipc'); print('connected',flush=True)
except OSError as error: print('denied:'+str(error.errno),flush=True)
os.chdir('/'); sys.stdin.readline(); s.setblocking(False)
try:
 data=s.recv(1); print('eof' if not data else 'data',flush=True)
except BlockingIOError: print('open',flush=True)
sys.stdin.readline()
`,
        ],
        { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      children.push(client);
      const [line] = await once(client.stdout, 'data');
      return { client, state: line.toString().trim() };
    };
    const complete = async () => {
      const exited =
        finish.exitCode === null && finish.signalCode === null
          ? once(finish, 'exit')
          : Promise.resolve([finish.exitCode, finish.signalCode]);
      writeFileSync(proceed, 'continue');
      const [code] = await exited;
      return {
        code,
        receipt: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null,
        error: existsSync(errors) ? readFileSync(errors, 'utf8') : '',
      };
    };
    await action({ fx, path, dir, socket, finish, journal, startClient, complete, realGit, marker, collision });
  } finally {
    writeFileSync(proceed, 'continue');
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
    spawnSync(realGit, ['-C', path, 'fsmonitor--daemon', 'stop']);
    rmSync(fx.root, { recursive: true, force: true });
  }
}
