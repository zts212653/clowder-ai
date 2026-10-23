const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Module initialization creates its log directory before any instance constructor.
const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-module-'));
const keys = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'CAT_CAFE_DESKTOP_INSTANCE_ROOT'];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys.slice(0, 4)) process.env[key] = moduleRoot;
delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
const ServiceManager = require('./service-manager');
for (const [key, value] of Object.entries(original)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
after(() => fs.rmSync(moduleRoot, { recursive: true, force: true }));

test('isolated desktop Redis probing, spawn and API env all use the same owned port', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-isolation-'));
  const manager = new ServiceManager(base, { frontendPort: 5158, apiPort: 3158, redisPort: 6367 });
  const probes = [],
    starts = [];
  const spawnProcess = manager._startProcess.bind(manager);
  manager._isPortOpen = async (port) => {
    probes.push(port);
    return false;
  };
  manager._commandExists = async () => true;
  manager._startProcess = (...args) => starts.push(args);
  manager._waitForPortWithFallback = async (port) => {
    probes.push(port);
    return true;
  };
  try {
    await manager._startRedis(base);
    const apiEnv = manager._buildApiEnv(base);
    assert.equal(apiEnv.PREVIEW_GATEWAY_PORT, '0');
    assert.equal(apiEnv.CAT_CAFE_RUNTIME_ROOT, base);
    assert.equal(apiEnv.CAT_CAFE_WORKSPACE_ROOT, path.join(base, 'project'));
    const previousWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      process.env.CAT_CAFE_WORKSPACE_ROOT = path.join(base, 'owner-workspace');
      assert.equal(manager._buildApiEnv(base).CAT_CAFE_WORKSPACE_ROOT, path.join(base, 'owner-workspace'));
    } finally {
      if (previousWorkspace === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspace;
    }
    assert.deepEqual(probes, [6367, 6367]);
    assert.equal(starts[0][2][1], '6367');
    // Observe the env received by a real, test-owned Node child; no API/Redis starts.
    const resultPath = path.join(base, 'env.json');
    spawnProcess(
      'probe',
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({redis:process.env.REDIS_URL,runtimeRoot:process.env.CAT_CAFE_RUNTIME_ROOT,workspaceRoot:process.env.CAT_CAFE_WORKSPACE_ROOT}))`,
      ],
      { envOverrides: apiEnv },
    );
    await new Promise((resolve) => manager.procs.probe.once('exit', resolve));
    assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf8')).redis, 'redis://localhost:6367');
    assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf8')).runtimeRoot, base);
    assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf8')).workspaceRoot, path.join(base, 'project'));
    assert.ok(ServiceManager.USER_DATA_DIR.startsWith(moduleRoot + path.sep));
    assert.ok(fs.existsSync(path.join(ServiceManager.USER_DATA_DIR, 'data/logs/desktop.log')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ordinary API child explicitly reuses existing host client homes', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-clients-'));
  const hostHome = path.join(base, 'host');
  const claude = path.join(hostHome, '.claude');
  const codex = path.join(hostHome, '.codex');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  const previous = Object.fromEntries(
    ['USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map((key) => [key, process.env[key]]),
  );
  process.env.USERPROFILE = hostHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  try {
    const manager = new ServiceManager(base, { frontendPort: 5158, apiPort: 3158, redisPort: 6367 });
    const resultPath = path.join(base, 'host-client-env.json');
    manager._startProcess(
      'api',
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(Object.fromEntries(['CLAUDE_CONFIG_DIR','CODEX_HOME'].map(k=>[k,process.env[k]]))))`,
      ],
      { envOverrides: manager._buildApiEnv(base) },
    );
    await new Promise((resolve) => manager.procs.api.once('exit', resolve));
    assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), {
      CLAUDE_CONFIG_DIR: fs.realpathSync.native(claude),
      CODEX_HOME: fs.realpathSync.native(codex),
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ordinary API child preserves explicit client homes instead of guessing they are stale', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-host-client-reset-'));
  const hostHome = path.join(base, 'host');
  const customHome = path.join(base, 'custom-clients');
  fs.mkdirSync(path.join(hostHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(hostHome, '.codex'), { recursive: true });
  const bindings = Object.fromEntries(
    ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'KIMI_CODE_HOME', 'PI_CODING_AGENT_DIR', 'npm_config_cache'].map(
      (key) => [key, path.join(customHome, key)],
    ),
  );
  for (const directory of Object.values(bindings)) fs.mkdirSync(directory, { recursive: true });
  const previous = Object.fromEntries(['USERPROFILE', ...Object.keys(bindings)].map((key) => [key, process.env[key]]));
  process.env.USERPROFILE = hostHome;
  Object.assign(process.env, bindings);
  try {
    const manager = new ServiceManager(base, { frontendPort: 5158, apiPort: 3158, redisPort: 6367 });
    const resultPath = path.join(base, 'host-client-env-reset.json');
    manager._startProcess(
      'api',
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(bindings))}.map(k=>[k,process.env[k]]))))`,
      ],
      { envOverrides: manager._buildApiEnv(base) },
    );
    await new Promise((resolve) => manager.procs.api.once('exit', resolve));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(resultPath, 'utf8')),
      Object.fromEntries(Object.entries(bindings).map(([key, directory]) => [key, fs.realpathSync.native(directory)])),
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

for (const contamination of [
  {
    WORLD_DB: '/sentinel/world.sqlite',
    TASK_OUTCOME_DB: '/sentinel/tasks.sqlite',
    GLOBAL_KNOWLEDGE_DB: '/sentinel/knowledge.sqlite',
    CODEX_HOME: '/sentinel/codex',
    CAT_CAFE_WORKSPACE_ROOT: '/sentinel/workspace',
    OPENAI_API_KEY: 'fake-sentinel',
  },
  { MEMORY_STORE: '1' },
  { CAT_CAFE_WORKSPACE_ROOT: '/sentinel/parent-owner-workspace' },
])
  test(`isolated child rejects inherited ${Object.keys(contamination).join(', ')}`, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-env-'));
    const input = {
      ...contamination,
      CAT_CAFE_DESKTOP_INSTANCE_ROOT: base,
      FRONTEND_PORT: '5158',
      API_SERVER_PORT: '3158',
      REDIS_PORT: '6367',
    };
    const previous = Object.fromEntries(Object.keys(input).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, input);
      const manager = new ServiceManager(base, { frontendPort: 5158, apiPort: 3158, redisPort: 6367 });
      const resultPath = path.join(base, 'capture.json');
      manager._startProcess(
        'probe',
        process.execPath,
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(Object.fromEntries(${JSON.stringify(['WORLD_DB', 'TASK_OUTCOME_DB', 'GLOBAL_KNOWLEDGE_DB', 'MEMORY_STORE', 'OPENAI_API_KEY', 'CODEX_HOME', 'REDIS_URL', 'CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT', 'ALLOWED_WORKSPACE_DIRS', 'PREVIEW_GATEWAY_PORT'])}.map(k=>[k,process.env[k]]))))`,
        ],
        { envOverrides: manager._buildApiEnv(base) },
      );
      await new Promise((resolve) => manager.procs.probe.once('exit', resolve));
      const captured = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      assert.deepEqual(captured, {
        CODEX_HOME: path.join(base, 'home', '.codex'),
        REDIS_URL: 'redis://localhost:6367',
        CAT_CAFE_RUNTIME_ROOT: base,
        CAT_CAFE_WORKSPACE_ROOT: path.join(base, 'project'),
        ALLOWED_WORKSPACE_DIRS: path.join(base, 'project'),
        PREVIEW_GATEWAY_PORT: '0',
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

test('isolated API does not inherit host client bindings without a client-homes mapping', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-client-deny-'));
  const clientKeys = [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'DSH_HOME',
    'KIMI_CODE_HOME',
    'PI_CODING_AGENT_DIR',
    'npm_config_cache',
  ];
  const input = {
    CAT_CAFE_DESKTOP_INSTANCE_ROOT: base,
    FRONTEND_PORT: '5158',
    API_SERVER_PORT: '3158',
    REDIS_PORT: '6367',
    ...Object.fromEntries(clientKeys.map((key) => [key, path.join(base, 'host-owned')])),
  };
  fs.mkdirSync(path.join(base, 'host-owned'));
  const previous = Object.fromEntries(Object.keys(input).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, input);
    const manager = new ServiceManager(base, { frontendPort: 5158, apiPort: 3158, redisPort: 6367 });
    const result = path.join(base, 'capture.json');
    manager._startProcess(
      'api',
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(result)},JSON.stringify(Object.fromEntries(${JSON.stringify([...clientKeys, 'HOME'])}.map(k=>[k,process.env[k]]))))`,
      ],
      { envOverrides: manager._buildApiEnv(base) },
    );
    await new Promise((resolve) => manager.procs.api.once('exit', resolve));
    assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { HOME: path.join(base, 'home') });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('explicit client homes reach the real API child while persistence and ordinary children remain isolated', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-client-reuse-'));
  const realClient = path.join(base, 'local-client');
  fs.mkdirSync(realClient);
  fs.writeFileSync(
    path.join(base, 'client-homes.json'),
    JSON.stringify({ claude: realClient, codex: realClient, dsh: realClient, kimi: realClient, pi: realClient }),
  );
  const input = {
    CAT_CAFE_DESKTOP_INSTANCE_ROOT: base,
    FRONTEND_PORT: '5158',
    API_SERVER_PORT: '3158',
    REDIS_PORT: '6367',
  };
  const previous = Object.fromEntries(Object.keys(input).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, input);
    const manager = new ServiceManager(base, { frontendPort: 5158, apiPort: 3158, redisPort: 6367 });
    for (const name of ['api', 'probe']) {
      const result = path.join(base, `${name}.json`);
      const keys = [
        'HOME',
        'CODEX_HOME',
        'CLAUDE_CONFIG_DIR',
        'DSH_HOME',
        'KIMI_CODE_HOME',
        'PI_CODING_AGENT_DIR',
        'REDIS_URL',
        'CAT_CAFE_DATA_DIR',
      ];
      manager._startProcess(
        name,
        process.execPath,
        [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(result)},JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))))`,
        ],
        { envOverrides: manager._buildApiEnv(base) },
      );
      await new Promise((resolve) => manager.procs[name].once('exit', resolve));
      const env = JSON.parse(fs.readFileSync(result, 'utf8'));
      assert.equal(env.HOME, path.join(base, 'home'));
      assert.equal(env.REDIS_URL, 'redis://localhost:6367');
      assert.equal(env.CAT_CAFE_DATA_DIR, path.join(base, 'data'));
      assert.equal(
        env.CODEX_HOME,
        name === 'api' ? fs.realpathSync.native(realClient) : path.join(base, 'home', '.codex'),
      );
      if (name === 'api')
        for (const key of keys.slice(1, 6)) assert.equal(env[key], fs.realpathSync.native(realClient));
      else assert.equal(env.KIMI_CODE_HOME, undefined);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
