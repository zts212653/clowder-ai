import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectAvailableClients } from '../dist/domains/cats/services/first-run-quest/client-detection.js';

const homeDir = join(process.cwd(), 'test-home-unused');
const claudePath = join(homeDir, '.claude', '.credentials.json');
const codexPath = join(homeDir, '.codex', 'auth.json');
const claude = { claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh' } };
const codex = { tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh' } };

async function detect(files, env = {}) {
  return detectAvailableClients({
    existsOnPath: async () => true,
    auth: {
      homeDir,
      env,
      readFile: (path) => {
        if (!(path in files)) throw new Error('missing');
        return typeof files[path] === 'string' ? files[path] : JSON.stringify(files[path]);
      },
    },
  });
}

test('native Claude and Codex OAuth credentials are detected without accounts or env keys', async () => {
  const clients = await detect({ [claudePath]: claude, [codexPath]: codex });
  for (const id of ['claude', 'codex']) {
    assert.equal(clients.find((client) => client.client === id)?.authenticated, true);
  }
  assert.equal(JSON.stringify(clients).includes('fake-access'), false);
  assert.equal(JSON.stringify(clients).includes('fake-refresh'), false);
});

test('CODEX_HOME selects the runtime account without falling back to ambient credentials', async () => {
  const custom = join(homeDir, 'custom-codex');
  const clients = await detect({ [codexPath]: codex }, { CODEX_HOME: custom });
  assert.equal(clients.find((client) => client.client === 'codex')?.authenticated, false);
  const loggedIn = await detect({ [join(custom, 'auth.json')]: codex }, { CODEX_HOME: custom });
  assert.equal(loggedIn.find((client) => client.client === 'codex')?.authenticated, true);
});

test('missing, malformed and incomplete credentials fail closed', async () => {
  for (const value of [
    '{',
    [],
    null,
    {},
    { tokens: { access_token: 7, refresh_token: 'x' } },
    { tokens: { access_token: ' ', refresh_token: 'x' } },
  ]) {
    const clients = await detect({ [codexPath]: value, [claudePath]: value });
    assert.equal(
      clients.some((client) => client.authenticated),
      false,
    );
  }
});

test('environment keys remain supported and whitespace keys are rejected', async () => {
  const clients = await detect(
    {},
    { OPENAI_API_KEY: 'fake-key', ANTHROPIC_API_KEY: ' ', GEMINI_API_KEY: 'fake-gemini' },
  );
  assert.equal(clients.find((client) => client.client === 'codex')?.authenticated, true);
  assert.equal(clients.find((client) => client.client === 'gemini')?.authenticated, true);
  assert.equal(clients.find((client) => client.client === 'claude')?.authenticated, false);
});

test('Codex CLI config with a custom endpoint and bearer value is treated as native authentication', async () => {
  const configPath = join(homeDir, '.codex', 'config.toml');
  const clients = await detect(
    {
      [configPath]: [
        'model = "gpt-5"',
        'model_provider = "kitcoding"',
        '[model_providers.unrelated]',
        'base_url = "https://unrelated.invalid/v1"',
        'experimental_bearer_token = "unrelated-secret"',
        '[model_providers.kitcoding]',
        'base_url = "https://example.invalid/v1"',
        'experimental_bearer_token = "fake-secret"',
        '',
      ].join('\n'),
    },
    {},
  );
  const codexClient = clients.find((client) => client.client === 'codex');
  assert.equal(codexClient?.authenticated, true);
  assert.equal(codexClient?.hasApiKey, false);
  assert.equal(JSON.stringify(clients).includes('fake-secret'), false);
});

test('Codex CLI config does not authenticate from an inactive provider section', async () => {
  const configPath = join(homeDir, '.codex', 'config.toml');
  const clients = await detect({
    [configPath]: [
      'model_provider = "kitcoding"',
      '[model_providers.unrelated]',
      'base_url = "https://unrelated.invalid/v1"',
      'experimental_bearer_token = "unrelated-secret"',
      '[model_providers.kitcoding]',
      'base_url = "https://example.invalid/v1"',
    ].join('\n'),
  });
  assert.equal(clients.find((client) => client.client === 'codex')?.authenticated, false);
});

test('OpenCode native auth accepts top-level OAuth credentials', async () => {
  const authPath = join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  const clients = await detect({
    [authPath]: { anthropic: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh' } },
  });
  assert.equal(clients.find((client) => client.client === 'opencode')?.authenticated, true);
  assert.equal(JSON.stringify(clients).includes('fixture-access'), false);
});

test('OpenCode native auth follows xdg data roots on every host platform', async () => {
  const linuxPath = join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  const linux = await detect({ [linuxPath]: { anthropic: { type: 'oauth', access: 'a', refresh: 'r' } } });
  assert.equal(linux.find((client) => client.client === 'opencode')?.authenticated, true);
  const windowsPath = join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  const windows = await detect(
    { [windowsPath]: { anthropic: { type: 'oauth', access: 'a', refresh: 'r' } } },
    { __PLATFORM__: 'win32' },
  );
  assert.equal(windows.find((client) => client.client === 'opencode')?.authenticated, true);
  const wrong = await detect(
    {
      [join(homeDir, 'AppData', 'Local', 'opencode', 'auth.json')]: {
        anthropic: { type: 'oauth', access: 'a', refresh: 'r' },
      },
    },
    { __PLATFORM__: 'win32' },
  );
  assert.equal(wrong.find((client) => client.client === 'opencode')?.authenticated, false);
});

test('Kimi native auth requires both access and refresh tokens', async () => {
  const authPath = join(homeDir, '.kimi', 'credentials', 'kimi-code.json');
  const clients = await detect({
    [authPath]: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' },
  });
  assert.equal(clients.find((client) => client.client === 'kimi')?.authenticated, true);
  assert.equal(JSON.stringify(clients).includes('fixture-access'), false);
});

test('Kimi native auth honors an explicit KIMI_SHARE_DIR', async () => {
  const shareDir = join(homeDir, 'custom-kimi');
  const authPath = join(shareDir, 'credentials', 'kimi-code.json');
  const clients = await detect(
    { [authPath]: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } },
    { KIMI_SHARE_DIR: shareDir },
  );
  assert.equal(clients.find((client) => client.client === 'kimi')?.authenticated, true);
  assert.equal(clients.find((client) => client.client === 'kimi')?.authType, 'native');
});

test('OpenCode native auth honors XDG_DATA_HOME and does not expose credentials', async () => {
  const dataHome = join(homeDir, 'xdg-data');
  const authPath = join(dataHome, 'opencode', 'auth.json');
  const clients = await detect(
    { [authPath]: { openai: { type: 'api', key: 'fixture-key' } } },
    { XDG_DATA_HOME: dataHome },
  );
  assert.equal(clients.find((client) => client.client === 'opencode')?.authenticated, true);
  assert.equal(JSON.stringify(clients).includes('fixture-key'), false);
});

test('OpenCode ignores an untyped auth entry instead of treating an arbitrary token as usable', async () => {
  const authPath = join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  const clients = await detect({ [authPath]: { random: { access_token: 'fixture-token' } } });
  assert.equal(clients.find((client) => client.client === 'opencode')?.authenticated, false);
});
