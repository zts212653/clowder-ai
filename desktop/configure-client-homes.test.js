const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readClientHomes } = require('./client-homes');

const names = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  dsh: 'DSH_HOME',
  kimi: 'KIMI_CODE_HOME',
  pi: 'PI_CODING_AGENT_DIR',
  npmCache: 'npm_config_cache',
};

for (const custom of [false, true]) {
  test(
    `Windows installer maps ${custom ? 'explicit' : 'default'} client directories consistently`,
    { skip: process.platform !== 'win32' },
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-clients-'));
      try {
        const home = path.join(root, 'user');
        const local = path.join(home, 'AppData', 'Local');
        const instance = path.join(root, 'instance');
        const defaults = {
          claude: path.join(home, '.claude'),
          codex: path.join(home, '.codex'),
          dsh: path.join(home, '.dsh'),
          kimi: path.join(home, '.kimi-code'),
          pi: path.join(home, '.pi', 'agent'),
          npmCache: path.join(local, 'npm-cache'),
        };
        const expected = Object.fromEntries(
          Object.entries(defaults).map(([key, directory]) => [
            key,
            custom ? path.join(root, 'custom', key) : directory,
          ]),
        );
        for (const directory of [...Object.values(defaults), ...Object.values(expected)])
          fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(expected.pi, 'settings.json'),
          '{"defaultProvider":"fixture","defaultModel":"fixture-model"}',
        );
        fs.writeFileSync(path.join(expected.pi, 'auth.json'), '{"fixture":{"type":"api_key","key":"test-only"}}');
        const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local };
        for (const [key, name] of Object.entries(names)) {
          if (custom) env[name] = expected[key];
          else delete env[name];
        }
        const configure = () =>
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              path.join(__dirname, 'scripts/configure-desktop-instance.ps1'),
              '-AppDir',
              path.join(root, 'install'),
              '-InstanceRoot',
              instance,
              '-FrontendPort',
              '5162',
              '-ApiPort',
              '3162',
              '-RedisPort',
              '6338',
            ],
            { env, stdio: 'pipe', timeout: 30000, windowsHide: true },
          );
        configure();
        const resolved = readClientHomes(instance);
        assert.deepEqual(
          resolved,
          Object.fromEntries(
            Object.entries(expected).map(([key, directory]) => [names[key], fs.realpathSync.native(directory)]),
          ),
        );
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(resolved.PI_CODING_AGENT_DIR, 'settings.json'))).defaultModel,
          'fixture-model',
        );
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(resolved.PI_CODING_AGENT_DIR, 'auth.json'))).fixture.key,
          'test-only',
        );
        const configured = fs.readFileSync(path.join(instance, 'client-homes.json'), 'utf8');
        env.CODEX_HOME = defaults.codex;
        configure();
        assert.equal(fs.readFileSync(path.join(instance, 'client-homes.json'), 'utf8'), configured);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
