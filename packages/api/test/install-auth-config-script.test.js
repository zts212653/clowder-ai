import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHelper, runHelperResult, runHelperWithEnv } from './install-auth-config-test-helpers.js';

test('claude-profile create and remove keeps installer-managed profile in sync', () => {
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

    const profileFile = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
    const secretsFile = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const profiles = JSON.parse(readFileSync(profileFile, 'utf8'));
    const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
    const installerManaged = profiles.providers.anthropic.profiles.find(
      (profile) => profile.id === 'installer-managed',
    );

    assert.equal(profiles.version, 1);
    assert.equal(profiles.providers.anthropic.activeProfileId, 'installer-managed');
    assert.equal(installerManaged?.baseUrl, 'https://claude.example');
    assert.equal(installerManaged?.modelOverride, 'claude-model');
    assert.equal(installerManaged?.provider, 'anthropic');
    assert.equal(installerManaged?.mode, 'api_key');
    assert.equal(secrets.version, 1);
    assert.equal(secrets.providers.anthropic['installer-managed'].apiKey, 'claude-key');

    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);

    const profilesAfterRemove = JSON.parse(readFileSync(profileFile, 'utf8'));
    const secretsAfterRemove = JSON.parse(readFileSync(secretsFile, 'utf8'));

    assert.equal(
      profilesAfterRemove.providers.anthropic.profiles.some((profile) => profile.id === 'installer-managed'),
      false,
    );
    assert.equal(profilesAfterRemove.providers.anthropic.activeProfileId, '');
    assert.equal('installer-managed' in (secretsAfterRemove.providers.anthropic ?? {}), false);
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

    const secretsFile = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
    assert.equal(secrets.providers.anthropic['installer-managed'].apiKey, 'env-api-key');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('claude-profile v2 migration preserves non-installer profiles and secrets on set/remove', () => {
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
          profiles: [
            {
              id: 'installer-managed',
              provider: 'anthropic',
              name: 'Installer API Key',
              authType: 'api_key',
              baseUrl: 'https://installer.example',
              modelOverride: 'claude-installer',
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:00.000Z',
            },
            {
              id: 'personal',
              provider: 'anthropic',
              name: 'Personal Key',
              authType: 'api_key',
              baseUrl: 'https://personal.example',
              modelOverride: 'claude-personal',
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
      '--model',
      'claude-new',
    ]);

    const migratedProfiles = JSON.parse(readFileSync(profileFile, 'utf8'));
    const migratedSecrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
    const personalProfile = migratedProfiles.providers.anthropic.profiles.find((profile) => profile.id === 'personal');
    const installerProfile = migratedProfiles.providers.anthropic.profiles.find(
      (profile) => profile.id === 'installer-managed',
    );

    assert.equal(migratedProfiles.version, 1);
    assert.equal(migratedProfiles.providers.anthropic.activeProfileId, 'installer-managed');
    assert.equal(personalProfile?.baseUrl, 'https://personal.example');
    assert.equal(personalProfile?.modelOverride, 'claude-personal');
    assert.equal(migratedSecrets.providers.anthropic.personal.apiKey, 'personal-key');
    assert.equal(installerProfile?.baseUrl, 'https://installer.new');
    assert.equal(installerProfile?.modelOverride, 'claude-new');
    assert.equal(migratedSecrets.providers.anthropic['installer-managed'].apiKey, 'new-installer-key');

    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);

    const profilesAfterRemove = JSON.parse(readFileSync(profileFile, 'utf8'));
    const secretsAfterRemove = JSON.parse(readFileSync(secretsFile, 'utf8'));

    assert.equal(
      profilesAfterRemove.providers.anthropic.profiles.some((profile) => profile.id === 'installer-managed'),
      false,
    );
    assert.equal(profilesAfterRemove.providers.anthropic.activeProfileId, 'personal');
    assert.equal(
      profilesAfterRemove.providers.anthropic.profiles.some((profile) => profile.id === 'personal'),
      true,
    );
    assert.equal(secretsAfterRemove.providers.anthropic.personal.apiKey, 'personal-key');
    assert.equal('installer-managed' in (secretsAfterRemove.providers.anthropic ?? {}), false);
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
