const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-user-path-'));
const storeEnvKeys = [
  'EVIDENCE_DB',
  'WORLD_DB',
  'TASK_OUTCOME_DB',
  'GLOBAL_KNOWLEDGE_DB',
  'LOG_DIR',
  'CAT_CAFE_DATA_DIR',
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
];
const envKeys = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CAT_CAFE_DESKTOP_INSTANCE_ROOT',
  'PATH',
  'FRONTEND_PORT',
  'API_SERVER_PORT',
  'REDIS_PORT',
  ...storeEnvKeys,
  'REDIS_URL',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
envKeys.slice(0, 4).forEach((key) => {
  process.env[key] = root;
});
storeEnvKeys.forEach((key) => {
  process.env[key] = path.join(root, key);
});
process.env.REDIS_URL = 'redis://127.0.0.1:6386';
delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;

const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const queries = [];
const children = [];
let queryResult;
let deferredQuery;
let realChildren = false;
childProcess.execFile = (executable, args, options, callback) => {
  queries.push({ executable, args, options });
  deferredQuery = () => callback(queryResult.error, queryResult.stdout, '');
  if (!queryResult.defer) queueMicrotask(deferredQuery);
  return new EventEmitter();
};
childProcess.spawn = (executable, args, options) => {
  children.push(options.env);
  return realChildren ? originalSpawn(executable, args, options) : new EventEmitter();
};
const ServiceManager = require('./service-manager');
const windowsUserPath = require('./windows-user-path');
const { mergeWindowsPath } = windowsUserPath;

after(() => {
  childProcess.spawn = originalSpawn;
  childProcess.execFile = originalExecFile;
  Object.entries(originalEnv).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

function manager(result) {
  queries.length = 0;
  children.length = 0;
  deferredQuery = undefined;
  queryResult = result;
  process.env.PATH = path.join(process.env.SystemRoot || '/windows', 'System32');
  ['packages/api/dist', 'packages/api/node_modules', 'node'].forEach((directory) => {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  });
  fs.writeFileSync(path.join(root, 'packages/api/dist/index.js'), '');
  fs.writeFileSync(path.join(root, 'node/node.exe'), '');
  const value = new ServiceManager(root, { frontendPort: 5186, apiPort: 3186, redisPort: 6386 });
  value._getUserDataDir = () => root;
  value._ensureUserDataDir = () => {};
  value._waitForProjectMirrors = async () => {};
  value._isPortOpen = async () => false;
  value._startRedis = async () => {};
  value._startPluginNetworkBridge = async () => {};
  value._startApi = async () => value._startProcess('api', process.execPath, []);
  value._startNextJs = () => value._startProcess('web', process.execPath, []);
  value._waitForHttpReady = async () => {};
  value.assertStartupProcessesRunning = () => {};
  return value;
}

const windowsOnly = { skip: process.platform !== 'win32' };

test('reads normal PATH once alongside Redis preparation and before API/Web start', windowsOnly, async () => {
  const paths = { normalPath: 'C:\\Windows\\System32;C:\\用户工具' };
  const value = manager({ defer: true, stdout: Buffer.from(JSON.stringify(paths)).toString('base64') });
  let redisStarted = false;
  value._startRedis = async () => {
    redisStarted = true;
  };
  const startup = value.startAll();
  try {
    await new Promise(setImmediate);
    assert.equal(queries.length, 1, 'startup must recover the registered user PATH');
    assert.equal(redisStarted, true, 'the registry read must not delay Redis preparation');
    assert.equal(children.length, 0, 'API and Web must wait for the recovered PATH');
    assert.equal(queries[0].options.windowsHide, true);
    assert.equal(queries[0].options.timeout, 8000);
    assert.equal(path.isAbsolute(queries[0].executable), true);
    assert.ok(queries[0].args.includes('-NoProfile'));
    assert.ok(queries[0].args.includes('-NonInteractive'));
  } finally {
    deferredQuery?.();
    await startup;
  }
  assert.equal(children.length, 2);
  assert.equal(queries.length, 1);
  children.forEach((env) => {
    const key = Object.keys(env).find((entry) => entry.toUpperCase() === 'PATH');
    assert.equal(env[key], paths.normalPath);
  });
});

test('cancels the PATH reader and starts no API/Web children after quitting', windowsOnly, async () => {
  const value = manager({ defer: true, stdout: '' });
  const startup = value.startAll();
  await new Promise(setImmediate);
  assert.equal(queries[0].options.signal, value.startupAbort.signal);
  value.startupAbort.abort();
  deferredQuery();
  await assert.rejects(startup, { name: 'AbortError' });
  assert.equal(children.length, 0);
});

test('continues startup if the PATH reader rejects, including failed preflight', windowsOnly, async () => {
  const originalReader = windowsUserPath.readWindowsPath;
  windowsUserPath.readWindowsPath = () => Promise.reject(new Error('reader unavailable'));
  try {
    const value = manager({ stdout: '' });
    await value.startAll();
    assert.equal(children.length, 2);
    const occupied = manager({ stdout: '' });
    occupied._isPortOpen = async () => true;
    await assert.rejects(occupied.startAll(), { code: 'DESKTOP_PORT_CONFLICT' });
  } finally {
    windowsUserPath.readWindowsPath = originalReader;
  }
});

test('inserts a missing user CLI before WindowsApps without moving parent directories', windowsOnly, async () => {
  const value = manager({ stdout: '' });
  const machinePath = 'C:\\Windows\\System32;C:\\MachineTools';
  const userPath = 'C:\\用户工具;C:\\WindowsApps';
  const inherited = `C:\\Custom;${machinePath};C:\\WindowsApps;C:\\ParentTools`;
  process.env.PATH = inherited;
  // The merge must run through the real spawn boundary for both services.
  value.windowsPath = `${machinePath};${userPath}`;
  value._startProcess('api', process.execPath, []);
  value._startProcess('web', process.execPath, []);
  children.forEach((env) => {
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
    assert.equal(keys.length, 1);
    assert.equal(env[keys[0]], `C:\\Custom;${machinePath};${userPath};C:\\ParentTools`);
  });
  assert.equal(process.env.PATH, inherited, 'the launcher environment must not be changed');
});

[
  { error: Object.assign(new Error('missing PowerShell'), { code: 'ENOENT' }), stdout: '' },
  { error: Object.assign(new Error('registry read timed out'), { killed: true }), stdout: '' },
  { label: 'empty output', error: null, stdout: '' },
  { label: 'invalid JSON', error: null, stdout: 'not-json' },
  { label: 'invalid schema', error: null, stdout: Buffer.from('{"normalPath":5}').toString('base64') },
  { label: 'empty PATH', error: null, stdout: Buffer.from('{"normalPath":""}').toString('base64') },
  { label: 'blank PATH', error: null, stdout: Buffer.from('{"normalPath":"  "}').toString('base64') },
].forEach((failure) => {
  test(
    `starts with the inherited PATH when the environment read returns ${failure.label || failure.error.message}`,
    windowsOnly,
    async () => {
      const value = manager(failure);
      const inherited = process.env.PATH;
      await value.startAll();
      assert.equal(queries.length, 1);
      assert.equal(children.length, 2);
      children.forEach((env) => {
        const key = Object.keys(env).find((entry) => entry.toUpperCase() === 'PATH');
        assert.equal(env[key], inherited);
      });
    },
  );
});

test('the real user environment PATH ignores missing and stale inherited variables', windowsOnly, async () => {
  const executable = require.resolve('./windows-user-path');
  const results = [];
  for (const state of ['clean', 'missing', 'stale']) {
    const env = { ...process.env };
    ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TOOL_HOME'].forEach((key) => {
      if (state === 'missing') delete env[key];
      if (state === 'stale') env[key] = path.join(root, 'stale', key);
    });
    const outputFile = path.join(root, `normal-path-${state}.json`);
    const child = originalSpawn(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(executable)}).readWindowsPath().then(paths=>require('node:fs').writeFileSync(${JSON.stringify(outputFile)},JSON.stringify(paths)));`,
      ],
      { env, windowsHide: true, stdio: 'ignore' },
    );
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    const normalPath = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(typeof normalPath, 'string', `${state}: native user environment read must succeed`);
    assert.ok(normalPath.trim());
    results.push(normalPath);
  }
  assert.equal(results[1], results[0]);
  assert.equal(results[2], results[0]);
});

test('keeps a complete parent PATH byte-for-byte, including its own priority', () => {
  const env = { Path: 'C:\\Parent;C:\\User;C:\\System', OTHER: 'kept' };
  const original = { ...env };
  mergeWindowsPath(env, 'C:\\System;C:\\User');
  assert.deepEqual(env, original);
});

test('uses the effective PATH key and removes duplicate casing without importing ignored values', () => {
  const env = { Path: 'C:\\Ignored', PATH: 'C:\\System;C:\\WindowsApps', OTHER: 'kept' };
  mergeWindowsPath(env, 'C:\\System;C:\\User;C:\\WindowsApps');
  assert.deepEqual(env, { PATH: 'C:\\System;C:\\User;C:\\WindowsApps', OTHER: 'kept' });
});

test('deduplicates quoted, slash and case variants when repairing a missing directory', () => {
  const env = { Path: 'C:\\SYSTEM;"c:/user/";C:\\WindowsApps\\;C:\\Parent' };
  mergeWindowsPath(env, 'C:\\System;C:\\User;C:\\New;C:\\WindowsApps;C:\\New');
  assert.equal(env.Path, 'C:\\SYSTEM;"c:/user/";C:\\New;C:\\WindowsApps\\;C:\\Parent');
});

test('does not rewrite PATH when the snapshot is already present or the read failed', () => {
  [null, 'C:\\Parent'].forEach((paths) => {
    const env = { Path: 'C:\\Parent' };
    mergeWindowsPath(env, paths);
    assert.deepEqual(env, { Path: 'C:\\Parent' });
  });
});

test('preserves custom command priority while appending missing unanchored directories', () => {
  const env = { Path: 'C:\\Custom;C:\\System' };
  mergeWindowsPath(env, 'C:\\System;C:\\User');
  assert.equal(env.Path, 'C:\\Custom;C:\\System;C:\\User');
});

test('inserts missing segments before their next inherited anchor and deduplicates additions', () => {
  const env = { Path: 'C:\\Custom;C:\\System;C:\\WindowsApps;C:\\Parent' };
  mergeWindowsPath(env, 'C:\\Machine;C:\\System;C:\\User;C:\\WindowsApps;C:\\Last;C:\\Last');
  assert.equal(env.Path, 'C:\\Custom;C:\\Machine;C:\\System;C:\\User;C:\\WindowsApps;C:\\Parent;C:\\Last');
});

test('uses the first duplicate anchor without deleting inherited entries or literal percent paths', () => {
  const env = { Path: 'C:\\Custom;C:\\Anchor;C:\\Anchor' };
  mergeWindowsPath(env, 'C:\\100%tools;C:\\Anchor');
  assert.equal(env.Path, 'C:\\Custom;C:\\100%tools;C:\\Anchor;C:\\Anchor');
});

test('sets a missing PATH key without an empty leading directory', () => {
  const env = { OTHER: 'kept' };
  mergeWindowsPath(env, 'C:\\System;C:\\User');
  assert.deepEqual(env, { OTHER: 'kept', Path: 'C:\\System;C:\\User' });
});

test('matches repeated machine anchors by occurrence when inserting a user directory', () => {
  const env = { Path: 'C:\\MachineTools;C:\\MachineTools' };
  mergeWindowsPath(env, 'C:\\MachineTools;C:\\UserTools;C:\\MachineTools');
  assert.equal(env.Path, 'C:\\MachineTools;C:\\UserTools;C:\\MachineTools');
});

test('does not use an explicitly promoted registered directory as a later anchor', () => {
  const env = { Path: 'C:\\Custom;C:\\MachineTools;C:\\WindowsApps' };
  mergeWindowsPath(env, 'C:\\MachineTools;C:\\UserTools;C:\\Custom;C:\\WindowsApps');
  assert.equal(env.Path, 'C:\\Custom;C:\\MachineTools;C:\\UserTools;C:\\WindowsApps');
});

test('keeps semicolons inside quoted PATH entries intact', () => {
  ['"', "'"].forEach((quote) => {
    const env = { Path: `${quote}C:\\Old;shared${quote};C:\\WindowsApps` };
    mergeWindowsPath(env, `${quote}C:\\New;shared${quote};${quote}C:\\Old;shared${quote};C:\\WindowsApps`);
    assert.equal(env.Path, `${quote}C:\\New;shared${quote};${quote}C:\\Old;shared${quote};C:\\WindowsApps`);
  });
});

test('retains empty entries and treats leading spaces as part of a relative directory', () => {
  const env = { Path: ' Tools;;WindowsApps;' };
  mergeWindowsPath(env, 'Tools;WindowsApps');
  assert.equal(env.Path, ' Tools;;Tools;WindowsApps;');
});

test('distinguishes drive roots and current-drive roots from relative or empty entries', () => {
  [
    ['C:', 'C:\\'],
    ['', '\\'],
    ['\\\\?\\C:', '\\\\?\\C:\\'],
  ].forEach(([relative, rooted]) => {
    const env = { Path: `${relative};C:\\WindowsApps` };
    mergeWindowsPath(env, `${rooted};C:\\WindowsApps`);
    assert.equal(env.Path, `${relative};${rooted};C:\\WindowsApps`);
  });
});

[false, true].forEach((isolated) => {
  test(
    `real Windows Node lookup preserves quoted semicolons and root PATH forms (isolated=${isolated})`,
    windowsOnly,
    async () => {
      const value = manager({ stdout: '' });
      const fixture = path.join(root, `semantics-${isolated}`);
      const [old, newer, work] = ['Old;shared', 'New;shared', 'work'].map((name) => path.join(fixture, name));
      [old, newer, work].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      const executable = path.join(fixture, 'issue1986-root.exe');
      fs.copyFileSync(process.execPath, executable);
      fs.linkSync(executable, path.join(old, 'issue1986-old.exe'));
      fs.linkSync(executable, path.join(newer, 'issue1986-new.exe'));
      const subst = path.join(process.env.SystemRoot, 'System32', 'subst.exe');
      const drive = ['Z:', 'Y:', 'X:', 'W:', 'V:'].find(
        (letter) => childProcess.spawnSync(subst, [letter, fixture], { windowsHide: true }).status === 0,
      );
      assert.ok(drive, 'root semantics require a temporary drive backed by the test fixture');
      if (isolated) {
        process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = path.join(root, 'isolated-semantics');
        process.env.FRONTEND_PORT = '5186';
        process.env.API_SERVER_PORT = '3186';
        process.env.REDIS_PORT = '6386';
      }
      realChildren = true;
      try {
        const scenarios = [
          {
            inherited: `"${old}"`,
            normal: `"${newer}";"${old}"`,
            cwd: work,
            commands: ['issue1986-old.exe', 'issue1986-new.exe'],
            expected: [path.join(old, 'issue1986-old.exe'), path.join(newer, 'issue1986-new.exe')],
          },
          ...[drive, ''].map((relative) => ({
            inherited: `${relative};${work}`,
            normal: `${relative}\\;${work}`,
            cwd: `${drive}\\work`,
            commands: ['issue1986-root.exe'],
            expected: [executable],
          })),
        ];
        for (const [index, scenario] of scenarios.entries()) {
          process.env.PATH = scenario.inherited;
          const inherited = process.env.PATH;
          value.windowsPath = scenario.normal;
          const outputFile = path.join(fixture, `lookup-${index}.json`);
          value._startProcess(
            'probe',
            process.execPath,
            [
              '-e',
              `const cp=require('node:child_process');const commands=${JSON.stringify(scenario.commands)}.map(name=>{const r=cp.spawnSync(name,['-p','process.execPath'],{encoding:'utf8',windowsHide:true});return {status:r.status,error:r.error?.code,executable:r.stdout?.trim()};});require('node:fs').writeFileSync(${JSON.stringify(outputFile)},JSON.stringify({commands,keys:Object.keys(process.env).filter(k=>k.toUpperCase()==='PATH'),home:process.env.HOME}));`,
            ],
            { cwd: scenario.cwd },
          );
          const [code] = await once(value.procs.probe, 'exit');
          assert.equal(code, 0);
          const captured = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
          captured.commands.forEach((command, commandIndex) => {
            assert.equal(command.error, undefined);
            assert.equal(command.status, 0);
            assert.equal(
              fs.realpathSync.native(command.executable),
              fs.realpathSync.native(scenario.expected[commandIndex]),
            );
          });
          assert.equal(captured.keys.length, 1);
          assert.equal(captured.home, isolated ? path.join(root, 'isolated-semantics', 'home') : root);
          assert.equal(process.env.PATH, inherited);
        }
      } finally {
        realChildren = false;
        delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
        assert.equal(childProcess.spawnSync(subst, [drive, '/D'], { windowsHide: true }).status, 0);
        assert.equal(fs.existsSync(`${drive}\\`), false);
      }
    },
  );
});

[false, true].forEach((isolated) => {
  ['repeated machine', 'promoted registered custom'].forEach((scenario) => {
    test(`real Windows command priority with ${scenario} anchors (isolated=${isolated})`, windowsOnly, async () => {
      const value = manager({ stdout: '' });
      const [machine, user, custom, alias] = ['machine', '用户工具', 'custom', 'WindowsApps'].map((name) =>
        path.join(root, `anchors-${isolated}-${scenario}`, name),
      );
      [machine, user, custom, alias].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      [
        [machine, 'priority', 'machine'],
        [user, 'priority', 'user-shadow'],
        [custom, 'priority', 'custom'],
        [user, 'tool', 'user'],
        [alias, 'tool', 'store-alias'],
      ].forEach(([dir, name, output]) => {
        fs.writeFileSync(path.join(dir, `issue1986-${name}.cmd`), `@echo ${output}\r\n`);
      });
      const repeated = scenario === 'repeated machine';
      process.env.PATH = (repeated ? [machine, machine, alias] : [custom, machine, alias]).join(';');
      const inherited = process.env.PATH;
      value.windowsPath = (repeated ? [machine, user, machine, alias] : [machine, user, custom, alias]).join(';');
      if (isolated) {
        process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = path.join(root, 'isolated-anchors');
        process.env.FRONTEND_PORT = '5186';
        process.env.API_SERVER_PORT = '3186';
        process.env.REDIS_PORT = '6386';
      }
      const outputFile = path.join(root, `anchors-${isolated}-${scenario}.json`);
      const shell = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
      realChildren = true;
      try {
        value._startProcess('probe', process.execPath, [
          '-e',
          `const cp=require('node:child_process');const commands=['priority','tool'].map(name=>cp.spawnSync(${JSON.stringify(shell)},['/d','/c','issue1986-'+name+'.cmd'],{encoding:'utf8',windowsHide:true}).stdout.trim());require('node:fs').writeFileSync(${JSON.stringify(outputFile)},JSON.stringify({commands,keys:Object.keys(process.env).filter(k=>k.toUpperCase()==='PATH'),home:process.env.HOME}));`,
        ]);
        const [code] = await once(value.procs.probe, 'exit');
        assert.equal(code, 0);
        const captured = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.deepEqual(captured.commands, [repeated ? 'machine' : 'custom', 'user']);
        assert.equal(captured.keys.length, 1);
        assert.equal(captured.home, isolated ? path.join(root, 'isolated-anchors', 'home') : root);
        assert.equal(process.env.PATH, inherited);
      } finally {
        realChildren = false;
        delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
      }
    });
  });
});

[false, true].forEach((isolated) => {
  test(
    `real Windows children resolve user and machine commands in order (isolated=${isolated})`,
    windowsOnly,
    async () => {
      const value = manager({ stdout: '' });
      const dirs = ['machine', '用户工具', 'WindowsApps', 'parent', 'custom'].map((name) => path.join(root, name));
      dirs.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      const [machine, user, alias, parent, custom] = dirs;
      [
        [user, 'user', 'user'],
        [alias, 'user', 'store-alias'],
        [machine, 'system', 'machine'],
        [user, 'system', 'user-shadow'],
        [parent, 'parent', 'parent'],
        [custom, 'custom', 'custom'],
        [machine, 'custom', 'machine-shadow'],
      ].forEach(([dir, name, output]) => {
        fs.writeFileSync(path.join(dir, `issue1986-${name}.cmd`), `@echo ${output}\r\n`);
      });
      process.env.PATH = [custom, machine, alias, parent].join(';');
      const inheritedPath = process.env.PATH;
      if (isolated) {
        process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = path.join(root, 'isolated');
        process.env.FRONTEND_PORT = '5186';
        process.env.API_SERVER_PORT = '3186';
        process.env.REDIS_PORT = '6386';
      }
      value.windowsPath = [machine, user, alias].join(';');
      const outputFile = path.join(root, `commands-${isolated}.json`);
      const shell = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
      realChildren = true;
      try {
        value._startProcess('probe', process.execPath, [
          '-e',
          `const cp=require('node:child_process'); const commands=['user','system','parent','custom'].map(name=>cp.spawnSync(${JSON.stringify(shell)},['/d','/c','issue1986-'+name+'.cmd'],{encoding:'utf8',windowsHide:true}).stdout.trim()); require('node:fs').writeFileSync(${JSON.stringify(outputFile)},JSON.stringify({commands,keys:Object.keys(process.env).filter(k=>k.toUpperCase()==='PATH'),home:process.env.HOME}));`,
        ]);
        const [code] = await once(value.procs.probe, 'exit');
        assert.equal(code, 0);
        const captured = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.deepEqual(captured.commands, ['user', 'machine', 'parent', 'custom']);
        assert.equal(captured.keys.length, 1);
        assert.equal(captured.home, isolated ? path.join(root, 'isolated', 'home') : root);
        assert.equal(process.env.PATH, inheritedPath);
      } finally {
        realChildren = false;
        delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
      }
    },
  );
});
