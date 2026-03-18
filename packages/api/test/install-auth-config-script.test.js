import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const installerManaged = profiles.profiles.find((profile) => profile.id === 'installer-managed');

    assert.equal(profiles.activeProfileId, 'installer-managed');
    assert.equal(profiles.activeProfileIds?.anthropic, 'installer-managed');
    assert.equal(profiles.activeProfileIds?.openai, 'codex-oauth');
    assert.equal(profiles.activeProfileIds?.google, 'gemini-oauth');
    assert.equal(installerManaged?.baseUrl, 'https://claude.example');
    assert.equal(installerManaged?.modelOverride, 'claude-model');
    assert.equal(installerManaged?.protocol, 'anthropic');
    assert.equal(installerManaged?.authType, 'api_key');
    assert.equal(secrets.profiles['installer-managed'].apiKey, 'claude-key');

    runHelper(['claude-profile', 'remove', '--project-dir', projectRoot]);

    const profilesAfterRemove = JSON.parse(readFileSync(profileFile, 'utf8'));
    const secretsAfterRemove = JSON.parse(readFileSync(secretsFile, 'utf8'));

    assert.equal(profilesAfterRemove.profiles.some((profile) => profile.id === 'installer-managed'), false);
    assert.equal(profilesAfterRemove.activeProfileId, 'claude-oauth');
    assert.equal(profilesAfterRemove.activeProfileIds?.anthropic, 'claude-oauth');
    assert.equal(profilesAfterRemove.activeProfileIds?.openai, 'codex-oauth');
    assert.equal(profilesAfterRemove.activeProfileIds?.google, 'gemini-oauth');
    assert.equal('installer-managed' in (secretsAfterRemove.profiles ?? {}), false);
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

    runHelper([
      'env-apply',
      '--env-file',
      envFile,
      '--set',
      "OPENAI_BASE_URL=https://proxy.example/o'hara",
    ]);

    const output = readFileSync(envFile, 'utf8');
    assert.match(output, /^OPENAI_BASE_URL="https:\/\/proxy\.example\/o'hara"$/m);
    assert.doesNotMatch(output, /'\\''/);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});
