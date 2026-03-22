import test from 'node:test';

import {
  assert,
  join,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  runSourceOnlySnippet,
  tmpdir,
  writeFileSync,
} from './install-script-test-helpers.js';

test('install script allows repo-shaped directories without .git', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-nogit-'));

  try {
    mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages', 'api'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"clowder-ai"}\n', 'utf8');

    const output = runSourceOnlySnippet(`
resolved="$(resolve_project_dir_from "${join(projectRoot, 'scripts', 'install.sh')}")"
printf '%s' "$resolved"
`);

    assert.equal(output, projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('install script clears stale OAuth/API env keys when switching back to OAuth', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-oauth-'));

  try {
    writeFileSync(
      join(envRoot, '.env'),
      `CODEX_AUTH_MODE='api_key'
OPENAI_API_KEY='old-openai-key'
OPENAI_BASE_URL='https://old.example/v1?foo=1&bar=2'
CAT_CODEX_MODEL='gpt-old'
GEMINI_API_KEY='old-gemini-key'
CAT_GEMINI_MODEL='gemini-old'
`,
      'utf8',
    );

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
reset_env_changes
set_codex_oauth_mode
set_gemini_oauth_mode
for key in "\${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "\${!ENV_KEYS[@]}"; do write_env_key "\${ENV_KEYS[$i]}" "\${ENV_VALUES[$i]}"; done
cat .env
`);

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

test('install script clears stale Codex and Gemini overrides when default values are selected', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-defaults-'));

  try {
    writeFileSync(
      join(envRoot, '.env'),
      `CODEX_AUTH_MODE='api_key'
OPENAI_API_KEY='old-openai-key'
OPENAI_BASE_URL='https://old.example/v1'
CAT_CODEX_MODEL='gpt-old'
GEMINI_API_KEY='old-gemini-key'
CAT_GEMINI_MODEL='gemini-old'
`,
      'utf8',
    );

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
reset_env_changes
set_codex_api_key_mode "new-openai-key" "" ""
set_gemini_api_key_mode "new-gemini-key" "" ""
for key in "\${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "\${!ENV_KEYS[@]}"; do write_env_key "\${ENV_KEYS[$i]}" "\${ENV_VALUES[$i]}"; done
cat .env
`);

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

test('Claude empty API key removes stale installer-managed profile', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-claude-empty-'));
  const catCafeDir = join(envRoot, '.cat-cafe');

  try {
    mkdirSync(catCafeDir, { recursive: true });
    writeFileSync(
      join(catCafeDir, 'provider-profiles.json'),
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: {
            activeProfileId: 'installer-managed',
            profiles: [{ id: 'installer-managed', provider: 'anthropic', name: 'Installer API Key', mode: 'api_key' }],
          },
        },
      }),
    );
    writeFileSync(
      join(catCafeDir, 'provider-profiles.secrets.local.json'),
      JSON.stringify({
        version: 1,
        providers: { anthropic: { 'installer-managed': { apiKey: 'sk-old-stale-key' } } },
      }),
    );

    runSourceOnlySnippet(`
PROJECT_DIR="${envRoot}"
remove_claude_installer_profile
`);

    const profiles = JSON.parse(readFileSync(join(catCafeDir, 'provider-profiles.json'), 'utf8'));
    const secrets = JSON.parse(readFileSync(join(catCafeDir, 'provider-profiles.secrets.local.json'), 'utf8'));
    const anthropic = profiles.providers?.anthropic;
    assert.ok(anthropic, 'anthropic provider entry should still exist');
    const installerProfile = (anthropic.profiles ?? []).find((profile) => profile.id === 'installer-managed');
    assert.equal(installerProfile, undefined, 'installer-managed profile must be removed');
    assert.notEqual(anthropic.activeProfileId, 'installer-managed', 'active profile must not be stale');
    assert.equal(secrets.providers?.anthropic?.['installer-managed'], undefined, 'secret must be removed');
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('npm_global_install succeeds when a custom registry is configured', () => {
  const output = runSourceOnlySnippet(`
SUDO=""
NPM_REGISTRY="https://registry.example.test"
env() {
  if [[ "$1" == npm_config_registry=* && "$2" == NPM_CONFIG_REGISTRY=* && "$3" == "npm" && "$4" == "install" && "$5" == "-g" && "$6" == "demo-pkg" ]]; then
    printf 'registry-install'
    return 0
  fi
  return 99
}
npm_global_install demo-pkg
printf '|status:%s' "$?"
`);

  assert.equal(output, 'registry-install|status:0');
});

test('docker reruns add API_SERVER_HOST when missing from existing .env', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-docker-missing-'));

  try {
    writeFileSync(join(envRoot, '.env'), "OTHER_KEY='keep-me'\n", 'utf8');

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
ENV_CREATED=false
docker_detected() { return 0; }
maybe_write_docker_api_host
cat .env
`);

    assert.match(output, /API_SERVER_HOST='0\.0\.0\.0'/, 'Must auto-write API_SERVER_HOST when missing');
    assert.match(output, /OTHER_KEY='keep-me'/, 'Must preserve other keys');
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('docker reruns preserve an existing API_SERVER_HOST value', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-docker-'));

  try {
    writeFileSync(
      join(envRoot, '.env'),
      `API_SERVER_HOST='127.0.0.1'
OTHER_KEY='keep-me'
`,
      'utf8',
    );

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
ENV_CREATED=false
docker_detected() { return 0; }
maybe_write_docker_api_host
cat .env
`);

    assert.match(output, /^API_SERVER_HOST='127.0.0.1'$/m);
    assert.match(output, /^OTHER_KEY='keep-me'$/m);
    assert.doesNotMatch(output, /^API_SERVER_HOST='0.0.0.0'$/m);
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});

test('use_registry sets only env vars without writing to user npmrc', () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'clowder-install-registry-'));

  try {
    const output = runSourceOnlySnippet(`
export HOME="${tmpHome}"
use_registry "https://mirror.example.test"
printf 'npm=%s|pnpm=%s' "$npm_config_registry" "$PNPM_CONFIG_REGISTRY"
[[ -f "${tmpHome}/.npmrc" ]] && printf '|LEAKED' || printf '|CLEAN'
`);

    assert.match(output, /npm=https:\/\/mirror\.example\.test/);
    assert.match(output, /pnpm=https:\/\/mirror\.example\.test/);
    assert.match(output, /\|CLEAN$/, 'use_registry must not write to ~/.npmrc');
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('default_frontend_url uses the internal frontend default port', () => {
  const output = runSourceOnlySnippet(`
unset FRONTEND_PORT
printf '%s' "$(default_frontend_url)"
`);

  assert.equal(output, 'http://localhost:3003');
});

test('default_frontend_url honors FRONTEND_PORT overrides', () => {
  const output = runSourceOnlySnippet(`
FRONTEND_PORT=3123
printf '%s' "$(default_frontend_url)"
`);

  assert.equal(output, 'http://localhost:3123');
});

test('default_frontend_url prefers the project .env FRONTEND_PORT', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-frontend-port-'));

  try {
    writeFileSync(join(envRoot, '.env'), "FRONTEND_PORT='3123'\n", 'utf8');

    const output = runSourceOnlySnippet(`
cd "${envRoot}"
FRONTEND_PORT=3555
printf '%s' "$(default_frontend_url)"
`);

    assert.equal(output, 'http://localhost:3123');
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});
