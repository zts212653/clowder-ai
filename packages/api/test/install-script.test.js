import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const installScript = resolve(repoRoot, 'scripts', 'install.sh');

function runSourceOnlySnippet(snippet) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\n${snippet}`],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(
    result.status,
    0,
    [`exit=${result.status}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join('\n'),
  );

  return result.stdout.trim();
}

test('install script allows repo-shaped directories without .git', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'clowder-install-nogit-'));

  try {
    mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages', 'api'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"clowder-ai"}\n', 'utf8');

    const output = runSourceOnlySnippet(
      `
resolved="$(resolve_project_dir_from "${join(projectRoot, 'scripts', 'install.sh')}")"
printf '%s' "$resolved"
`,
    );

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
      [
        "CODEX_AUTH_MODE='api_key'",
        "OPENAI_API_KEY='old-openai-key'",
        "OPENAI_BASE_URL='https://old.example/v1?foo=1&bar=2'",
        "CAT_CODEX_MODEL='gpt-old'",
        "GEMINI_API_KEY='old-gemini-key'",
        "CAT_GEMINI_MODEL='gemini-old'",
      ].join('\n') + '\n',
      'utf8',
    );

    const output = runSourceOnlySnippet(
      `
cd "${envRoot}"
reset_env_changes
set_codex_oauth_mode
set_gemini_oauth_mode
for key in "\${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "\${!ENV_KEYS[@]}"; do write_env_key "\${ENV_KEYS[$i]}" "\${ENV_VALUES[$i]}"; done
cat .env
`,
    );

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
      [
        "CODEX_AUTH_MODE='api_key'",
        "OPENAI_API_KEY='old-openai-key'",
        "OPENAI_BASE_URL='https://old.example/v1'",
        "CAT_CODEX_MODEL='gpt-old'",
        "GEMINI_API_KEY='old-gemini-key'",
        "CAT_GEMINI_MODEL='gemini-old'",
      ].join('\n') + '\n',
      'utf8',
    );

    const output = runSourceOnlySnippet(
      `
cd "${envRoot}"
reset_env_changes
set_codex_api_key_mode "new-openai-key" "" ""
set_gemini_api_key_mode "new-gemini-key" ""
for key in "\${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "\${!ENV_KEYS[@]}"; do write_env_key "\${ENV_KEYS[$i]}" "\${ENV_VALUES[$i]}"; done
cat .env
`,
    );

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
