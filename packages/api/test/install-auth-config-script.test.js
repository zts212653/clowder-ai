import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHelper, runHelperResult, runHelperWithEnv } from './install-auth-config-test-helpers.js';

function readInstallerState(projectRoot) {
  const profileDir = join(projectRoot, '.cat-cafe');
  const profileFile = join(profileDir, 'provider-profiles.json');
  const secretsFile = join(profileDir, 'provider-profiles.secrets.local.json');
  return {
    profileFile,
    secretsFile,
    profiles: JSON.parse(readFileSync(profileFile, 'utf8')),
    secrets: JSON.parse(readFileSync(secretsFile, 'utf8')),
  };
}

test('client-auth set creates a generic api key account and bootstrap binding for the selected client', () => {
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

    const { profiles, secrets } = readInstallerState(projectRoot);
    const apiKeyAccount = profiles.providers.find((profile) => profile.id === 'installer-anthropic');

    assert.deepEqual(profiles.bootstrapBindings, {
      anthropic: { enabled: true, mode: 'api_key', accountRef: 'installer-anthropic' },
      openai: { enabled: true, mode: 'oauth', accountRef: 'codex' },
      google: { enabled: true, mode: 'oauth', accountRef: 'gemini' },
      dare: { enabled: false, mode: 'skip' },
      opencode: { enabled: false, mode: 'skip' },
    });
    assert.deepEqual(apiKeyAccount, {
      id: 'installer-anthropic',
      displayName: 'API Key Account 1',
      kind: 'api_key',
      authType: 'api_key',
      builtin: false,
      baseUrl: 'https://proxy.example.dev',
      createdAt: apiKeyAccount.createdAt,
      updatedAt: apiKeyAccount.updatedAt,
    });
    assert.equal(secrets.profiles['installer-anthropic'].apiKey, 'generic-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth remove drops the installer api key account and restores oauth bootstrap', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-remove-'));

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

    runHelper(['client-auth', 'remove', '--project-dir', projectRoot, '--client', 'openai']);

    const { profiles, secrets } = readInstallerState(projectRoot);
    assert.equal(profiles.providers.some((profile) => profile.id === 'installer-openai'), false);
    assert.deepEqual(profiles.bootstrapBindings.openai, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'codex',
    });
    assert.equal('installer-openai' in (secrets.profiles ?? {}), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('client-auth set oauth restores builtin bindings for dare and opencode', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-client-auth-oauth-'));

  try {
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'dare', '--mode', 'oauth']);
    runHelper(['client-auth', 'set', '--project-dir', projectRoot, '--client', 'opencode', '--mode', 'oauth']);

    const { profiles } = readInstallerState(projectRoot);
    assert.deepEqual(profiles.bootstrapBindings.dare, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'dare',
    });
    assert.deepEqual(profiles.bootstrapBindings.opencode, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'opencode',
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
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

    const { profiles, secrets } = readInstallerState(projectRoot);
    const installerManaged = profiles.providers.find((profile) => profile.id === 'installer-managed');

    assert.equal(profiles.version, 3);
    assert.deepEqual(profiles.bootstrapBindings.anthropic, {
      enabled: true,
      mode: 'api_key',
      accountRef: 'installer-managed',
    });
    assert.deepEqual(profiles.bootstrapBindings.openai, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'codex',
    });
    assert.deepEqual(profiles.bootstrapBindings.google, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'gemini',
    });
    assert.deepEqual(profiles.bootstrapBindings.dare, { enabled: false, mode: 'skip' });
    assert.deepEqual(profiles.bootstrapBindings.opencode, { enabled: false, mode: 'skip' });
    assert.deepEqual(installerManaged, {
      id: 'installer-managed',
      displayName: 'Installer API Key',
      kind: 'api_key',
      authType: 'api_key',
      builtin: false,
      baseUrl: 'https://claude.example',
      models: ['claude-model'],
      createdAt: installerManaged.createdAt,
      updatedAt: installerManaged.updatedAt,
    });
    assert.equal(secrets.profiles['installer-managed'].apiKey, 'claude-key');

    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);

    const afterRemove = readInstallerState(projectRoot);
    assert.equal(afterRemove.profiles.providers.some((profile) => profile.id === 'installer-managed'), false);
    assert.deepEqual(afterRemove.profiles.bootstrapBindings.anthropic, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'claude',
    });
    assert.equal('installer-managed' in (afterRemove.secrets.profiles ?? {}), false);
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
          owner: { name: 'Co-worker', aliases: [], mentionPatterns: ['@co-worker'] },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const result = runHelperResult(['client-auth', 'remove', '--project-dir', projectRoot, '--client', 'openai']);

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /still referenced by runtime cats: runtime-codex/i);

    const { profiles, secrets } = readInstallerState(projectRoot);
    assert.equal(profiles.providers.some((profile) => profile.id === 'installer-openai'), true);
    assert.deepEqual(profiles.bootstrapBindings.openai, {
      enabled: true,
      mode: 'api_key',
      accountRef: 'installer-openai',
    });
    assert.equal(secrets.profiles['installer-openai'].apiKey, 'codex-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile remove is a no-op on a fresh project without provider profile files', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-remove-empty-'));

  try {
    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);
    assert.equal(existsSync(join(projectRoot, '.cat-cafe')), false);
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

    const { secrets } = readInstallerState(projectRoot);
    assert.equal(secrets.profiles['installer-managed'].apiKey, 'env-api-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile set preserves non-anthropic bindings when migrating a legacy v2 file', () => {
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
          activeProfileIds: {
            openai: 'openai-sponsor',
          },
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

    const { profiles, secrets } = readInstallerState(projectRoot);
    assert.equal(profiles.version, 3);
    assert.deepEqual(profiles.bootstrapBindings.anthropic, {
      enabled: true,
      mode: 'api_key',
      accountRef: 'installer-managed',
    });
    assert.deepEqual(profiles.bootstrapBindings.openai, {
      enabled: true,
      mode: 'api_key',
      accountRef: 'openai-sponsor',
    });
    const openaiSponsor = profiles.providers.find((profile) => profile.id === 'openai-sponsor');
    assert.equal(Boolean(openaiSponsor), true);
    assert.equal(openaiSponsor?.protocol, 'openai');
    assert.equal(secrets.profiles['openai-sponsor'].apiKey, 'openai-key');
    assert.equal(secrets.profiles['installer-managed'].apiKey, 'claude-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile v2 migration preserves non-installer accounts and secrets on set/remove', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-v2-migrate-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    mkdirSync(profileDir, { recursive: true });
    const profileFile = join(profileDir, 'provider-profiles.json');
    const secretsFile = join(profileDir, 'provider-profiles.secrets.local.json');

    writeFileSync(
      profileFile,
      `${JSON.stringify(
        {
          version: 2,
          activeProfileId: 'personal',
          activeProfileIds: {
            anthropic: 'personal',
          },
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
      secretsFile,
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

    const migrated = readInstallerState(projectRoot);
    const personalProfile = migrated.profiles.providers.find((profile) => profile.id === 'personal');
    const installerProfile = migrated.profiles.providers.find((profile) => profile.id === 'installer-managed');

    assert.equal(migrated.profiles.version, 3);
    assert.deepEqual(migrated.profiles.bootstrapBindings.anthropic, {
      enabled: true,
      mode: 'api_key',
      accountRef: 'installer-managed',
    });
    assert.equal(personalProfile?.baseUrl, 'https://personal.example');
    assert.equal(migrated.secrets.profiles.personal.apiKey, 'personal-key');
    assert.equal(installerProfile?.baseUrl, 'https://installer.new');
    assert.equal(migrated.secrets.profiles['installer-managed'].apiKey, 'new-installer-key');

    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);

    const afterRemove = readInstallerState(projectRoot);
    assert.equal(afterRemove.profiles.providers.some((profile) => profile.id === 'installer-managed'), false);
    assert.deepEqual(afterRemove.profiles.bootstrapBindings.anthropic, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'claude',
    });
    assert.equal(afterRemove.profiles.providers.some((profile) => profile.id === 'personal'), true);
    assert.equal(afterRemove.secrets.profiles.personal.apiKey, 'personal-key');
    assert.equal('installer-managed' in (afterRemove.secrets.profiles ?? {}), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile set fails fast on malformed provider profile JSON', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-bad-profile-'));

  try {
    const profileDir = join(projectRoot, '.cat-cafe');
    const profileFile = join(profileDir, 'provider-profiles.json');
    const secretsFile = join(profileDir, 'provider-profiles.secrets.local.json');
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
    assert.match(String(result.stderr), /provider-profiles\.json/);
    assert.equal(readFileSync(profileFile, 'utf8'), originalContents);
    assert.equal(existsSync(secretsFile), false);
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
