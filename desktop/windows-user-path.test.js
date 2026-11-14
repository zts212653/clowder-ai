const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-user-path-'));
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
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
envKeys.slice(0, 4).forEach((key) => {
  process.env[key] = root;
});
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

test('reads registered PATH once alongside Redis preparation and before API/Web start', windowsOnly, async () => {
  const paths = { machinePath: 'C:\\Windows\\System32', userPath: 'C:\\用户工具' };
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
    assert.equal(queries[0].options.timeout, 5000);
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
    assert.equal(env[key], `${paths.machinePath};${paths.userPath}`);
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

test('restores machine then user PATH order when a user CLI is missing', windowsOnly, async () => {
  const value = manager({ stdout: '' });
  const machinePath = 'C:\\Windows\\System32;C:\\MachineTools';
  const userPath = 'C:\\用户工具;C:\\WindowsApps';
  const inherited = `${machinePath};C:\\WindowsApps;C:\\ParentTools`;
  process.env.PATH = inherited;
  // The merge must run through the real spawn boundary for both services.
  value.windowsPath = { machinePath, userPath };
  value._startProcess('api', process.execPath, []);
  value._startProcess('web', process.execPath, []);
  children.forEach((env) => {
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
    assert.equal(keys.length, 1);
    assert.equal(env[keys[0]], `${machinePath};${userPath};C:\\ParentTools`);
  });
  assert.equal(process.env.PATH, inherited, 'the launcher environment must not be changed');
});

[
  { error: Object.assign(new Error('missing PowerShell'), { code: 'ENOENT' }), stdout: '' },
  { error: Object.assign(new Error('registry read timed out'), { killed: true }), stdout: '' },
  { error: null, stdout: '' },
  { error: null, stdout: 'not-json' },
  { error: null, stdout: Buffer.from('{"machinePath":5,"userPath":[]}').toString('base64') },
  { error: null, stdout: Buffer.from('{"machinePath":"","userPath":"C:\\\\User"}').toString('base64') },
  { error: null, stdout: Buffer.from('{"machinePath":"  ","userPath":"C:\\\\User"}').toString('base64') },
].forEach((failure) => {
  test(
    `starts with the inherited PATH when the registry read returns ${failure.error?.message || 'empty'}`,
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

test('the real PowerShell reader returns machine and user PATH strings', windowsOnly, async () => {
  const outputFile = path.join(root, 'registered-paths.json');
  const executable = require.resolve('./windows-user-path');
  const child = originalSpawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(executable)}).readWindowsPath().then(paths=>require('node:fs').writeFileSync(${JSON.stringify(outputFile)},JSON.stringify(paths)));`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const paths = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(typeof paths.machinePath, 'string');
  assert.equal(typeof paths.userPath, 'string');
});

test('keeps a complete parent PATH byte-for-byte, including its own priority', () => {
  const env = { Path: 'C:\\Parent;C:\\User;C:\\System', OTHER: 'kept' };
  const original = { ...env };
  mergeWindowsPath(env, { machinePath: 'C:\\System', userPath: 'C:\\User' });
  assert.deepEqual(env, original);
});

test('uses the effective PATH key and removes duplicate casing without importing ignored values', () => {
  const env = { Path: 'C:\\Ignored', PATH: 'C:\\System;C:\\WindowsApps', OTHER: 'kept' };
  mergeWindowsPath(env, { machinePath: 'C:\\System', userPath: 'C:\\User;C:\\WindowsApps' });
  assert.deepEqual(env, { PATH: 'C:\\System;C:\\User;C:\\WindowsApps', OTHER: 'kept' });
});

test('deduplicates quoted, slash and case variants when repairing a missing directory', () => {
  const env = { Path: 'C:\\SYSTEM;"c:/user/";C:\\WindowsApps\\;C:\\Parent' };
  mergeWindowsPath(env, { machinePath: 'C:\\System', userPath: 'C:\\User;C:\\New;C:\\WindowsApps;C:\\New' });
  assert.equal(env.Path, 'C:\\System;C:\\User;C:\\New;C:\\WindowsApps;C:\\Parent');
});

test('does not rewrite PATH when no user directories are registered or the read failed', () => {
  [null, { machinePath: 'C:\\System', userPath: '' }].forEach((paths) => {
    const env = { Path: 'C:\\Parent' };
    mergeWindowsPath(env, paths);
    assert.deepEqual(env, { Path: 'C:\\Parent' });
  });
});

[false, true].forEach((isolated) => {
  test(
    `real Windows children resolve user and machine commands in order (isolated=${isolated})`,
    windowsOnly,
    async () => {
      const value = manager({ stdout: '' });
      const dirs = ['machine', '用户工具', 'WindowsApps', 'parent'].map((name) => path.join(root, name));
      dirs.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      const [machine, user, alias, parent] = dirs;
      [
        [user, 'user', 'user'],
        [alias, 'user', 'store-alias'],
        [machine, 'system', 'machine'],
        [user, 'system', 'user-shadow'],
        [parent, 'parent', 'parent'],
      ].forEach(([dir, name, output]) => {
        fs.writeFileSync(path.join(dir, `issue1986-${name}.cmd`), `@echo ${output}\r\n`);
      });
      process.env.PATH = [machine, alias, parent].join(';');
      if (isolated) {
        process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = path.join(root, 'isolated');
        process.env.FRONTEND_PORT = '5186';
        process.env.API_SERVER_PORT = '3186';
        process.env.REDIS_PORT = '6386';
      }
      value.windowsPath = { machinePath: machine, userPath: [user, alias].join(';') };
      const outputFile = path.join(root, `commands-${isolated}.json`);
      const shell = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
      realChildren = true;
      try {
        value._startProcess('probe', process.execPath, [
          '-e',
          `const cp=require('node:child_process'); const commands=['user','system','parent'].map(name=>cp.spawnSync(${JSON.stringify(shell)},['/d','/c','issue1986-'+name+'.cmd'],{encoding:'utf8',windowsHide:true}).stdout.trim()); require('node:fs').writeFileSync(${JSON.stringify(outputFile)},JSON.stringify({commands,keys:Object.keys(process.env).filter(k=>k.toUpperCase()==='PATH'),home:process.env.HOME}));`,
        ]);
        const [code] = await once(value.procs.probe, 'exit');
        assert.equal(code, 0);
        const captured = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        assert.deepEqual(captured.commands, ['user', 'machine', 'parent']);
        assert.equal(captured.keys.length, 1);
        assert.equal(captured.home, isolated ? path.join(root, 'isolated', 'home') : root);
      } finally {
        realChildren = false;
        delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
      }
    },
  );
});
