import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  runHelper,
  runHelperNoGlobalOverride,
  runHelperResult,
  runHelperWithEnv,
} from './install-auth-config-test-helpers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// clowder-ai#340: installer now writes to accounts.json + credentials.json (global)
function readInstallerState(projectRoot) {
  const catCafeDir = join(projectRoot, '.cat-cafe');
  const accountsFile = join(catCafeDir, 'accounts.json');
  const credentialsFile = join(catCafeDir, 'credentials.json');
  return {
    accountsFile,
    credentialsFile,
    accounts: existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')) : {},
    credentials: existsSync(credentialsFile) ? JSON.parse(readFileSync(credentialsFile, 'utf8')) : {},
  };
}

test('client-auth set creates a generic api key account for the selected client', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-'));

  try {
    runHelper([
      'client-auth',
      'set',
      '--project-dir',
      projectRoot,
      '--client',
      'anthropic',
      '--mode',
      'api_key',
      '--display-name',
      'API Key Account 1',
      '--api-key',
      'generic-key',
      '--base-url',
      'https://proxy.example.dev',
    ]);

    const { accounts, credentials } = readInstallerState(projectRoot);
    const account = accounts['installer-anthropic'];

    assert.ok(account, 'installer-anthropic account should exist');
    assert.equal(account.authType, 'api_key');
    // clowder-ai#340: protocol no longer persisted on new accounts — derived at runtime
    assert.equal(account.protocol, undefined, 'protocol should not be persisted');
    assert.equal(account.baseUrl, 'https://proxy.example.dev');
    assert.equal(credentials['installer-anthropic'].apiKey, 'generic-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth remove without --force exits non-zero and preserves account', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-remove-noop-'));

  try {
    runHelper([
      'client-auth',
      'set',
      '--project-dir',
      projectRoot,
      '--client',
      'openai',
      '--mode',
      'api_key',
      '--api-key',
      'codex-key',
    ]);

    const result = runHelperResult(['client-auth', 'remove', '--project-dir', projectRoot, '--client', 'openai']);
    assert.notEqual(result.status, 0, 'should exit non-zero without --force');
    assert.match(result.stderr, /--force/i, 'stderr should mention --force');

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.ok(accounts['installer-openai'], 'account preserved without --force');
    assert.equal(credentials['installer-openai'].apiKey, 'codex-key', 'credential preserved without --force');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth remove --force drops the installer api key account', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-remove-force-'));

  try {
    runHelper([
      'client-auth',
      'set',
      '--project-dir',
      projectRoot,
      '--client',
      'openai',
      '--mode',
      'api_key',
      '--api-key',
      'codex-key',
    ]);

    runHelper(['client-auth', 'remove', '--project-dir', projectRoot, '--client', 'openai', '--force', 'true']);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts['installer-openai'], undefined, 'account removed with --force');
    assert.equal(credentials['installer-openai'], undefined, 'credential removed with --force');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set oauth creates builtin accounts for dare and opencode', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-oauth-'));

  try {
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'dare', '--mode', 'oauth']);
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'opencode', '--mode', 'oauth']);

    const { accounts } = readInstallerState(projectRoot);
    assert.equal(accounts.dare?.authType, 'oauth');
    assert.equal(accounts.opencode?.authType, 'oauth');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set oauth stores builtin default models for the selected client', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-oauth-models-'));

  try {
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth']);

    const { accounts } = readInstallerState(projectRoot);
    assert.equal(accounts.codex?.authType, 'oauth');
    assert.deepEqual(accounts.codex?.models, ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.3-codex-spark']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set oauth supports kimi and stores its default models', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-kimi-oauth-'));

  try {
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'kimi', '--mode', 'oauth']);

    const { accounts } = readInstallerState(projectRoot);
    assert.equal(accounts.kimi?.authType, 'oauth');
    assert.equal(accounts.kimi?.displayName, 'Kimi');
    assert.deepEqual(accounts.kimi?.models, ['kimi-code/kimi-for-coding']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set oauth sanitizes malformed builtin default models before writing state', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-claude-oauth-models-'));

  try {
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'anthropic', '--mode', 'oauth']);

    const { accounts } = readInstallerState(projectRoot);
    assert.equal(accounts.claude?.authType, 'oauth');
    assert.deepEqual(accounts.claude?.models, ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101']);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set ignores unreferenced homedir legacy experiment profiles', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-homedir-legacy-filter-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'clowder-install-fake-home-'));

  try {
    const profileDir = join(fakeHome, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          providers: [
            { id: 'installer-openai', authType: 'api_key', baseUrl: 'https://api.openai.com/v1' },
            { id: 'agent-teams-local', authType: 'api_key', displayName: 'Agent Teams Local' },
            {
              id: 'codex-sponsor',
              authType: 'api_key',
              displayName: 'codex-sponsor',
              baseUrl: 'https://openai.example/v1',
              models: ['gpt-5.4'],
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify(
        {
          profiles: {
            'installer-openai': { apiKey: 'sk-installer-openai' },
            'agent-teams-local': { apiKey: 'sk-agent-teams-local' },
            'codex-sponsor': { apiKey: 'sk-codex-sponsor' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    runHelperWithEnv(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth'], {
      HOME: fakeHome,
    });

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts.codex?.authType, 'oauth');
    assert.equal(accounts['installer-openai']?.baseUrl, 'https://api.openai.com/v1');
    assert.equal(credentials['installer-openai']?.apiKey, 'sk-installer-openai');
    assert.equal(accounts['agent-teams-local'], undefined, 'unreferenced homedir experiment must not migrate');
    assert.equal(accounts['codex-sponsor'], undefined, 'unreferenced homedir fixture must not migrate');
    assert.equal(credentials['agent-teams-local'], undefined, 'skipped experiment credential must not migrate');
    assert.equal(credentials['codex-sponsor'], undefined, 'skipped fixture credential must not migrate');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('client-auth set imports homedir legacy profile referenced by catalog.accounts', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-homedir-catalog-accounts-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'clowder-install-fake-home-catalog-accounts-'));

  try {
    const runtimeDir = join(projectRoot, '.cat-cafe');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'cat-catalog.json'),
      `${JSON.stringify(
        {
          version: 2,
          breeds: [],
          roster: {},
          reviewPolicy: {},
          accounts: {
            'legacy-custom': {
              authType: 'api_key',
              baseUrl: 'https://legacy-custom.example/v1',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const profileDir = join(fakeHome, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          providers: [{ id: 'legacy-custom', authType: 'api_key', baseUrl: 'https://legacy-custom.example/v1' }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify({ profiles: { 'legacy-custom': { apiKey: 'sk-legacy-custom' } } }, null, 2)}\n`,
      'utf8',
    );

    runHelperWithEnv(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth'], {
      HOME: fakeHome,
    });

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts.codex?.authType, 'oauth');
    assert.equal(accounts['legacy-custom']?.baseUrl, 'https://legacy-custom.example/v1');
    assert.equal(credentials['legacy-custom']?.apiKey, 'sk-legacy-custom');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('client-auth set imports homedir legacy profile referenced by providerProfileId', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-homedir-provider-profile-id-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'clowder-install-fake-home-provider-profile-id-'));

  try {
    const runtimeDir = join(projectRoot, '.cat-cafe');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'cat-catalog.json'),
      `${JSON.stringify(
        {
          version: 2,
          breeds: [
            {
              id: 'legacy-custom',
              variants: [{ id: 'legacy-custom-default', providerProfileId: 'legacy-provider-profile' }],
            },
          ],
          roster: {},
          reviewPolicy: {},
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const profileDir = join(fakeHome, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          providers: [
            {
              id: 'legacy-provider-profile',
              authType: 'api_key',
              baseUrl: 'https://legacy-provider.example/v1',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify({ profiles: { 'legacy-provider-profile': { apiKey: 'sk-legacy-provider' } } }, null, 2)}\n`,
      'utf8',
    );

    runHelperWithEnv(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth'], {
      HOME: fakeHome,
    });

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts.codex?.authType, 'oauth');
    assert.equal(accounts['legacy-provider-profile']?.baseUrl, 'https://legacy-provider.example/v1');
    assert.equal(credentials['legacy-provider-profile']?.apiKey, 'sk-legacy-provider');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('claude-profile create and remove keeps installer-managed account in sync', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-profile-'));

  try {
    runHelper([
      'claude-profile',
      'set',
      '--project-dir',
      projectRoot,
      '--api-key',
      'claude-key',
      '--base-url',
      'https://claude.example',
      '--model',
      'claude-model',
    ]);

    const { accounts, credentials } = readInstallerState(projectRoot);
    const installerManaged = accounts['installer-managed'];

    assert.ok(installerManaged, 'installer-managed account should exist');
    assert.equal(installerManaged.authType, 'api_key');
    // clowder-ai#340: protocol no longer persisted on new accounts — derived at runtime
    assert.equal(installerManaged.protocol, undefined, 'protocol should not be persisted');
    assert.equal(installerManaged.baseUrl, 'https://claude.example');
    assert.deepEqual(installerManaged.models, ['claude-model']);
    assert.equal(credentials['installer-managed'].apiKey, 'claude-key');

    // Without --force: exits non-zero, nothing deleted
    const safeResult = runHelperResult(['claude-profile', 'remove', '--project-dir', projectRoot]);
    assert.notEqual(safeResult.status, 0, 'should exit non-zero without --force');
    const afterSafeRemove = readInstallerState(projectRoot);
    assert.ok(afterSafeRemove.accounts['installer-managed'], 'account preserved without --force');
    assert.equal(
      afterSafeRemove.credentials['installer-managed'].apiKey,
      'claude-key',
      'credential preserved without --force',
    );

    // With --force: actually deletes
    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot, '--force', 'true']);
    const afterRemove = readInstallerState(projectRoot);
    assert.equal(afterRemove.accounts['installer-managed'], undefined, 'account removed with --force');
    assert.equal(afterRemove.credentials['installer-managed'], undefined, 'credential removed with --force');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth remove fails when the installer-managed account is still referenced by a runtime member', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-remove-bound-'));

  try {
    runHelper([
      'client-auth',
      'set',
      '--project-dir',
      projectRoot,
      '--client',
      'openai',
      '--mode',
      'api_key',
      '--api-key',
      'codex-key',
    ]);

    const runtimeDir = join(projectRoot, '.cat-cafe');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'cat-catalog.json'),
      `${JSON.stringify(
        {
          version: 2,
          breeds: [
            {
              id: 'runtime-codex',
              catId: 'runtime-codex',
              name: '运行时缅因猫',
              displayName: '运行时缅因猫',
              avatar: '/avatars/codex.png',
              color: { primary: '#16a34a', secondary: '#bbf7d0' },
              mentionPatterns: ['@runtime-codex'],
              roleDescription: '审查',
              defaultVariantId: 'runtime-codex-default',
              variants: [
                {
                  id: 'runtime-codex-default',
                  provider: 'openai',
                  accountRef: 'installer-openai',
                  defaultModel: 'gpt-5.4',
                  mcpSupport: true,
                  cli: { command: 'codex', outputFormat: 'json' },
                },
              ],
            },
          ],
          roster: {},
          reviewPolicy: {},
          coCreator: { name: 'Co-worker', aliases: [], mentionPatterns: ['@co-worker'] },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = runHelperResult(['client-auth', 'remove', '--project-dir', projectRoot, '--client', 'openai']);

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /still referenced by runtime cats: runtime-codex/i);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.ok(accounts['installer-openai'], 'account should NOT be removed');
    assert.equal(credentials['installer-openai'].apiKey, 'codex-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile remove is a no-op on a fresh project without config files', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-remove-empty-'));

  try {
    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);
    // Global .cat-cafe may be created but accounts.json should not exist
    const { accounts } = readInstallerState(projectRoot);
    assert.deepEqual(accounts, {});
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile set accepts API key from _INSTALLER_API_KEY environment variable', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-env-key-'));

  try {
    runHelperWithEnv(['claude-profile', 'set', '--project-dir', projectRoot], {
      _INSTALLER_API_KEY: 'env-api-key',
    });

    const { credentials } = readInstallerState(projectRoot);
    assert.equal(credentials['installer-managed'].apiKey, 'env-api-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile set migrates and preserves non-anthropic accounts from legacy v2 file', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-profile-legacy-v2-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          activeProfileId: 'personal',
          activeProfileIds: { openai: 'openai-sponsor' },
          profiles: [
            {
              id: 'claude-oauth',
              provider: 'claude-oauth',
              displayName: 'Claude (OAuth)',
              authType: 'oauth',
              protocol: 'anthropic',
              builtin: true,
              createdAt: '2026-03-18T00:00:00.000Z',
              updatedAt: '2026-03-18T00:00:00.000Z',
            },
            {
              id: 'openai-sponsor',
              provider: 'openai-sponsor',
              displayName: 'OpenAI Sponsor',
              authType: 'api_key',
              protocol: 'openai',
              builtin: false,
              baseUrl: 'https://openai.example',
              createdAt: '2026-03-18T00:00:00.000Z',
              updatedAt: '2026-03-18T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify({ version: 2, profiles: { 'openai-sponsor': { apiKey: 'openai-key' } } }, null, 2)}\n`,
      'utf8',
    );

    runHelper([
      'claude-profile',
      'set',
      '--project-dir',
      projectRoot,
      '--api-key',
      'claude-key',
      '--base-url',
      'https://claude.example',
    ]);

    const { accounts, credentials } = readInstallerState(projectRoot);
    // Legacy openai-sponsor migrated (clowder-ai#340: protocol not migrated)
    assert.ok(accounts['openai-sponsor'], 'legacy openai-sponsor should be migrated');
    assert.equal(accounts['openai-sponsor'].protocol, undefined, 'protocol should not be migrated');
    assert.equal(accounts['openai-sponsor'].baseUrl, 'https://openai.example');
    assert.equal(credentials['openai-sponsor'].apiKey, 'openai-key');
    // New installer-managed applied (clowder-ai#340: no protocol on new accounts)
    assert.equal(accounts['installer-managed'].protocol, undefined, 'new account should not have protocol');
    assert.equal(credentials['installer-managed'].apiKey, 'claude-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set infers legacy api_key authType from mode/kind fields during migration', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-legacy-authtype-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          profiles: [
            {
              id: 'legacy-mode-profile',
              provider: 'legacy-mode-profile',
              displayName: 'Legacy Mode Profile',
              mode: 'api_key',
              protocol: 'openai',
              baseUrl: 'https://mode.example',
            },
            {
              id: 'legacy-kind-profile',
              provider: 'legacy-kind-profile',
              displayName: 'Legacy Kind Profile',
              kind: 'api_key',
              protocol: 'anthropic',
              baseUrl: 'https://kind.example',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify(
        {
          version: 2,
          profiles: {
            'legacy-mode-profile': { apiKey: 'mode-key' },
            'legacy-kind-profile': { apiKey: 'kind-key' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'openai', '--mode', 'oauth']);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts['legacy-mode-profile']?.authType, 'api_key');
    assert.equal(accounts['legacy-kind-profile']?.authType, 'api_key');
    assert.equal(credentials['legacy-mode-profile']?.apiKey, 'mode-key');
    assert.equal(credentials['legacy-kind-profile']?.apiKey, 'kind-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set migrates v1 nested provider profiles and secrets before writing new auth state', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-legacy-v1-profiles-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 1,
          providers: {
            anthropic: {
              activeProfileId: 'my-proxy',
              profiles: [
                {
                  id: 'my-proxy',
                  displayName: 'My Proxy',
                  authType: 'api_key',
                  baseUrl: 'https://proxy.example/v1',
                },
                {
                  id: 'team-key',
                  displayName: 'Team Key',
                  mode: 'api_key',
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify(
        {
          version: 1,
          providers: {
            anthropic: {
              'my-proxy': { apiKey: 'sk-proxy-key' },
              'team-key': { apiKey: 'sk-team-key' },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'openai', '--mode', 'oauth']);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts['my-proxy']?.authType, 'api_key');
    assert.equal(accounts['my-proxy']?.displayName, 'My Proxy');
    assert.equal(accounts['my-proxy']?.baseUrl, 'https://proxy.example/v1');
    assert.equal(accounts['team-key']?.authType, 'api_key');
    assert.equal(accounts.anthropic, undefined, 'should not create a shell account from the client key');
    assert.equal(credentials['my-proxy']?.apiKey, 'sk-proxy-key');
    assert.equal(credentials['team-key']?.apiKey, 'sk-team-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile v2 migration preserves non-installer accounts and secrets on set/remove', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-v2-migrate-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });

    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          activeProfileId: 'personal',
          activeProfileIds: { anthropic: 'personal' },
          profiles: [
            {
              id: 'installer-managed',
              provider: 'installer-managed',
              displayName: 'Installer API Key',
              authType: 'api_key',
              protocol: 'anthropic',
              builtin: false,
              baseUrl: 'https://installer.example',
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:00.000Z',
            },
            {
              id: 'personal',
              provider: 'personal',
              displayName: 'Personal Key',
              authType: 'api_key',
              protocol: 'anthropic',
              builtin: false,
              baseUrl: 'https://personal.example',
              createdAt: '2026-03-02T00:00:00.000Z',
              updatedAt: '2026-03-02T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify(
        {
          version: 2,
          profiles: {
            'installer-managed': { apiKey: 'installer-key' },
            personal: { apiKey: 'personal-key' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    runHelper([
      'claude-profile',
      'set',
      '--project-dir',
      projectRoot,
      '--api-key',
      'new-installer-key',
      '--base-url',
      'https://installer.new',
    ]);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.equal(accounts.personal?.baseUrl, 'https://personal.example');
    assert.equal(credentials.personal.apiKey, 'personal-key');
    // installer-managed overwritten by the new set command
    assert.equal(accounts['installer-managed']?.baseUrl, 'https://installer.new');
    assert.equal(credentials['installer-managed'].apiKey, 'new-installer-key');

    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot, '--force', 'true']);

    const afterRemove = readInstallerState(projectRoot);
    assert.equal(afterRemove.accounts['installer-managed'], undefined, 'installer-managed removed with --force');
    assert.ok(afterRemove.accounts.personal, 'personal account preserved');
    assert.equal(afterRemove.credentials.personal.apiKey, 'personal-key');
    assert.equal(afterRemove.credentials['installer-managed'], undefined, 'installer credential removed');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile set fails fast on malformed legacy provider profile JSON', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-bad-profile-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    const profileFile = join(profileDir, 'provider-profiles.json');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(profileFile, '{"version": 1,', 'utf8');

    const originalContents = readFileSync(profileFile, 'utf8');
    const result = runHelperResult([
      'claude-profile',
      'set',
      '--project-dir',
      projectRoot,
      '--api-key',
      'new-installer-key',
    ]);

    assert.notEqual(result.status, 0);
    // The error references the parse failure
    assert.ok(String(result.stderr).length > 0, 'stderr should contain error details');
    assert.equal(readFileSync(profileFile, 'utf8'), originalContents, 'corrupt file must not be modified');
    assert.equal(existsSync(join(profileDir, 'accounts.json')), false, 'accounts.json should not be created');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('env-apply writes apostrophes with dotenv-compatible double quotes', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-apostrophe-'));

  try {
    const envFile = join(envRoot, '.env');
    mkdirSync(envRoot, { recursive: true });
    writeFileSync(envFile, '', 'utf8');

    runHelper(['env-apply', '--env-file', envFile, '--set', "OPENAI_BASE_URL=https://proxy.example/o'hara"]);

    const output = readFileSync(envFile, 'utf8');
    assert.match(output, /^OPENAI_BASE_URL="https:\/\/proxy\.example\/o'hara"$/m);
    assert.doesNotMatch(output, /'\\''/);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('env-apply escapes shell substitutions when apostrophe requires double quotes', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-shell-escape-'));

  try {
    const envFile = join(envRoot, '.env');
    const literal = "https://proxy.example/o'hara/$HOME/$(whoami)/`whoami`";
    mkdirSync(envRoot, { recursive: true });
    writeFileSync(envFile, '', 'utf8');

    runHelper(['env-apply', '--env-file', envFile, '--set', `OPENAI_BASE_URL=${literal}`]);

    const output = readFileSync(envFile, 'utf8');
    assert.match(
      output,
      /^OPENAI_BASE_URL="https:\/\/proxy\.example\/o'hara\/\\\$HOME\/\\\$\(whoami\)\/\\`whoami\\`"$/m,
    );

    const sourced = execFileSync('sh', ['-lc', `set -a; . "${envFile}"; printf '%s' "$OPENAI_BASE_URL"`], {
      encoding: 'utf8',
    }).trim();
    assert.equal(sourced, literal);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('#340 P6 regression: OAuth switch with explicit remove-then-set cleans stale installer profile', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-oauth-switch-'));

  try {
    // Step 1: Create an installer API-key profile for codex
    runHelperWithEnv(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'api_key'], {
      _INSTALLER_API_KEY: 'sk-old-codex-key',
    });
    const before = readInstallerState(projectRoot);
    assert.ok(before.accounts['installer-openai'], 'installer-openai account should exist');

    // Step 2: Switch to OAuth — caller must remove first, then set.
    // set --mode oauth does NOT auto-delete installer accounts (they're global;
    // only removeClientAuth has the safety checks for cross-project bindings).
    runHelper(['client-auth', 'remove', '--project-dir', projectRoot, '--client', 'codex', '--force', 'true']);
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth']);

    const after = readInstallerState(projectRoot);
    assert.equal(after.accounts['installer-openai'], undefined, 'installer-openai must be removed by explicit remove');
    assert.equal(after.credentials['installer-openai'], undefined, 'credentials must be removed');
    assert.ok(after.accounts.codex, 'builtin codex account must exist');
    assert.equal(after.accounts.codex.authType, 'oauth');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('set --mode oauth preserves stale installer account (global safety)', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-oauth-no-autodelete-'));

  try {
    // Step 1: Create installer API-key account
    runHelperWithEnv(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'api_key'], {
      _INSTALLER_API_KEY: 'sk-stale-key',
    });

    // Step 2: set --mode oauth WITHOUT remove — installer account must survive
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth']);

    const after = readInstallerState(projectRoot);
    // installer-openai intentionally preserved — global accounts can't be safely
    // auto-deleted without cross-project enumeration
    assert.ok(after.accounts['installer-openai'], 'installer-openai must NOT be auto-deleted');
    assert.ok(after.credentials['installer-openai'], 'credentials must NOT be auto-deleted');
    // OAuth account still created
    assert.ok(after.accounts.codex, 'builtin codex account must exist');
    assert.equal(after.accounts.codex.authType, 'oauth');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set retries legacy secret import when account already exists from a partial migration', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-retry-secret-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });

    writeFileSync(
      join(profileDir, 'accounts.json'),
      `${JSON.stringify(
        {
          'my-custom': {
            authType: 'api_key',
            baseUrl: 'https://custom.api/v1',
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.json'),
      `${JSON.stringify(
        {
          version: 2,
          providers: [{ id: 'my-custom', authType: 'api_key', baseUrl: 'https://custom.api/v1' }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeFileSync(
      join(profileDir, 'provider-profiles.secrets.local.json'),
      `${JSON.stringify(
        {
          profiles: {
            'my-custom': { apiKey: 'sk-retry-key' },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'codex', '--mode', 'oauth']);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.ok(accounts['my-custom'], 'existing migrated account should still be present');
    assert.equal(credentials['my-custom']?.apiKey, 'sk-retry-key', 'missing credential should be imported on retry');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('#340 P1: installer stores accounts in --project-dir without CAT_CAFE_GLOBAL_CONFIG_ROOT env', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-no-env-override-'));

  try {
    // Run WITHOUT CAT_CAFE_GLOBAL_CONFIG_ROOT — exercises _activeProjectDir fallback.
    // Before the fix, this would fall back to homedir() and write to ~/.cat-cafe/.
    const result = runHelperNoGlobalOverride([
      'client-auth',
      'set',
      '--project-dir',
      projectRoot,
      '--client',
      'anthropic',
      '--mode',
      'api_key',
      '--api-key',
      'test-key-no-env',
      '--display-name',
      'No Env Override',
    ]);
    assert.equal(result.status, 0, `installer should succeed, stderr: ${result.stderr}`);

    // Verify accounts landed in the project dir, not homedir
    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.ok(accounts['installer-anthropic'], 'account should be in project-dir/.cat-cafe/');
    assert.equal(accounts['installer-anthropic'].authType, 'api_key');
    assert.equal(credentials['installer-anthropic']?.apiKey, 'test-key-no-env');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth remove --force fails closed when the runtime catalog cannot be parsed', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-remove-bad-catalog-'));

  try {
    runHelper([
      'client-auth',
      'set',
      '--project-dir',
      projectRoot,
      '--client',
      'openai',
      '--mode',
      'api_key',
      '--api-key',
      'codex-key',
    ]);

    const runtimeDir = join(projectRoot, '.cat-cafe');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'cat-catalog.json'), '{"version": 2, "breeds": [', 'utf8');

    const result = runHelperResult([
      'client-auth',
      'remove',
      '--project-dir',
      projectRoot,
      '--client',
      'openai',
      '--force',
      'true',
    ]);

    assert.notEqual(result.status, 0, 'forced remove should fail when catalog parsing fails');
    assert.match(String(result.stderr), /failed to parse|unexpected end|json/i);

    const { accounts, credentials } = readInstallerState(projectRoot);
    assert.ok(accounts['installer-openai'], 'account should be preserved on parse failure');
    assert.equal(
      credentials['installer-openai']?.apiKey,
      'codex-key',
      'credential should be preserved on parse failure',
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('test sandbox blocks installer writes to the real repo root', () => {
  const accountsPath = join(REPO_ROOT, '.cat-cafe', 'accounts.json');
  const credentialsPath = join(REPO_ROOT, '.cat-cafe', 'credentials.json');
  const beforeAccounts = existsSync(accountsPath) ? readFileSync(accountsPath, 'utf8') : null;
  const beforeCredentials = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : null;
  const helperScript = join(REPO_ROOT, 'scripts', 'install-auth-config.mjs');
  const result = spawnSync(
    'node',
    [
      helperScript,
      'client-auth',
      'set',
      '--project-dir',
      REPO_ROOT,
      '--client',
      'openai',
      '--mode',
      'api_key',
      '--api-key',
      'should-not-write',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAT_CAFE_TEST_SANDBOX: '1',
        CAT_CAFE_GLOBAL_CONFIG_ROOT: REPO_ROOT,
        HOME: REPO_ROOT,
      },
    },
  );

  assert.notEqual(result.status, 0, 'script must fail closed when test sandbox targets repo root');
  assert.match(String(result.stderr), /test sandbox|repo root|unsafe/i);
  if (beforeAccounts === null) assert.equal(existsSync(accountsPath), false, 'repo accounts.json must stay absent');
  else assert.equal(readFileSync(accountsPath, 'utf8'), beforeAccounts, 'repo accounts.json must stay unchanged');
  if (beforeCredentials === null) {
    assert.equal(existsSync(credentialsPath), false, 'repo credentials.json must stay absent');
  } else {
    assert.equal(readFileSync(credentialsPath, 'utf8'), beforeCredentials, 'repo credentials.json must stay unchanged');
  }
});
