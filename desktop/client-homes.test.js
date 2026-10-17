const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readClientHomes } = require('./client-homes');

test('client reuse is opt-in and never inherits the host platform data environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-homes-'));
  try {
    assert.deepEqual(readClientHomes(null), {});
    assert.deepEqual(readClientHomes(root), {});
    const names = {
      claude: 'CLAUDE_CONFIG_DIR',
      codex: 'CODEX_HOME',
      dsh: 'DSH_HOME',
      kimi: 'KIMI_CODE_HOME',
      pi: 'PI_CODING_AGENT_DIR',
      npmCache: 'npm_config_cache',
    };
    const config = Object.fromEntries(Object.keys(names).map((key) => [key, path.join(root, key)]));
    for (const value of Object.values(config)) fs.mkdirSync(value);
    fs.writeFileSync(path.join(root, 'client-homes.json'), JSON.stringify(config));
    assert.deepEqual(
      readClientHomes(root),
      Object.fromEntries(Object.entries(names).map(([key, env]) => [env, fs.realpathSync.native(config[key])])),
    );
    assert.equal(Object.hasOwn(readClientHomes(root), 'HOME'), false);
    assert.equal(Object.hasOwn(readClientHomes(root), 'REDIS_URL'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid client reuse paths and unrelated environment overrides fail closed without exposing values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-homes-invalid-'));
  try {
    for (const config of [
      { codex: '../relative' },
      { pi: path.join(root, 'missing') },
      { HOME: root },
      { REDIS_URL: 'redis://secret' },
      [],
      null,
    ]) {
      fs.writeFileSync(path.join(root, 'client-homes.json'), JSON.stringify(config));
      assert.throws(() => readClientHomes(root), { message: 'Invalid desktop client-homes configuration' });
    }
    fs.writeFileSync(path.join(root, 'client-homes.json'), '{');
    assert.throws(() => readClientHomes(root), { message: 'Invalid desktop client-homes configuration' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
