import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const helperScript = resolve(repoRoot, 'scripts', 'install-auth-config.mjs');

function runHelper(args) {
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runHelperResult(args) {
  return spawnSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('env-apply clears stale OAuth/API env keys when switching back to OAuth', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-oauth-'));

  try {
    const envFile = join(envRoot, '.env');
    mkdirSync(envRoot, { recursive: true });
    execFileSync(
      'sh',
      [
        '-lc',
        `cat <<'EOF' > "${envFile}"
CODEX_AUTH_MODE='api_key'
OPENAI_API_KEY='old-openai-key'
OPENAI_BASE_URL='https://old.example/v1?foo=1&bar=2'
CAT_CODEX_MODEL='gpt-old'
GEMINI_API_KEY='old-gemini-key'
CAT_GEMINI_MODEL='gemini-old'
EOF`,
      ],
      { encoding: 'utf8' },
    );

    runHelper([
      'env-apply',
      '--env-file',
      envFile,
      '--set',
      'CODEX_AUTH_MODE=oauth',
      '--delete',
      'OPENAI_API_KEY',
      '--delete',
      'OPENAI_BASE_URL',
      '--delete',
      'CAT_CODEX_MODEL',
      '--delete',
      'GEMINI_API_KEY',
      '--delete',
      'CAT_GEMINI_MODEL',
    ]);

    const output = readFileSync(envFile, 'utf8');
    assert.match(output, /^CODEX_AUTH_MODE='oauth'$/m);
    assert.doesNotMatch(output, /^OPENAI_API_KEY=/m);
    assert.doesNotMatch(output, /^OPENAI_BASE_URL=/m);
    assert.doesNotMatch(output, /^CAT_CODEX_MODEL=/m);
    assert.doesNotMatch(output, /^GEMINI_API_KEY=/m);
    assert.doesNotMatch(output, /^CAT_GEMINI_MODEL=/m);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('env-apply clears stale Codex and Gemini overrides when default values are selected', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-defaults-'));

  try {
    const envFile = join(envRoot, '.env');
    mkdirSync(envRoot, { recursive: true });
    execFileSync(
      'sh',
      [
        '-lc',
        `cat <<'EOF' > "${envFile}"
CODEX_AUTH_MODE='api_key'
OPENAI_API_KEY='old-openai-key'
OPENAI_BASE_URL='https://old.example/v1'
CAT_CODEX_MODEL='gpt-old'
GEMINI_API_KEY='old-gemini-key'
CAT_GEMINI_MODEL='gemini-old'
EOF`,
      ],
      { encoding: 'utf8' },
    );

    runHelper([
      'env-apply',
      '--env-file',
      envFile,
      '--set',
      'CODEX_AUTH_MODE=api_key',
      '--set',
      'OPENAI_API_KEY=new-openai-key',
      '--set',
      'GEMINI_API_KEY=new-gemini-key',
      '--delete',
      'OPENAI_BASE_URL',
      '--delete',
      'CAT_CODEX_MODEL',
      '--delete',
      'CAT_GEMINI_MODEL',
    ]);

    const output = readFileSync(envFile, 'utf8');
    assert.match(output, /^CODEX_AUTH_MODE='api_key'$/m);
    assert.match(output, /^OPENAI_API_KEY='new-openai-key'$/m);
    assert.match(output, /^GEMINI_API_KEY='new-gemini-key'$/m);
    assert.doesNotMatch(output, /^OPENAI_BASE_URL=/m);
    assert.doesNotMatch(output, /^CAT_CODEX_MODEL=/m);
    assert.doesNotMatch(output, /^CAT_GEMINI_MODEL=/m);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

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
    execFileSync('node', [helperScript, 'claude-profile', 'set', '--project-dir', projectRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, _INSTALLER_API_KEY: 'env-api-key' },
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
