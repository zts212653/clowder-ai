import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHelper } from './install-auth-config-test-helpers.js';

test('env-apply clears stale OAuth/API env keys when switching back to OAuth', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-oauth-'));

  try {
    const envFile = join(envRoot, '.env');
    mkdirSync(envRoot, { recursive: true });
    writeFileSync(
      envFile,
      `CODEX_AUTH_MODE='api_key'
OPENAI_API_KEY='old-openai-key'
OPENAI_BASE_URL='https://old.example/v1?foo=1&bar=2'
CAT_CODEX_MODEL='gpt-old'
GEMINI_API_KEY='old-gemini-key'
CAT_GEMINI_MODEL='gemini-old'
`,
      'utf8',
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
    writeFileSync(
      envFile,
      `CODEX_AUTH_MODE='api_key'
OPENAI_API_KEY='old-openai-key'
OPENAI_BASE_URL='https://old.example/v1'
CAT_CODEX_MODEL='gpt-old'
GEMINI_API_KEY='old-gemini-key'
CAT_GEMINI_MODEL='gemini-old'
`,
      'utf8',
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

test('env-apply escapes CR/LF so one logical key stays on one line', () => {
  const envRoot = mkdtempSync(join(tmpdir(), 'clowder-install-env-crlf-'));

  try {
    const envFile = join(envRoot, '.env');
    mkdirSync(envRoot, { recursive: true });
    writeFileSync(envFile, '', 'utf8');

    runHelper([
      'env-apply',
      '--env-file',
      envFile,
      '--set',
      'OPENAI_BASE_URL=https://proxy.example/line1\nline2\r\nline3',
    ]);

    const output = readFileSync(envFile, 'utf8');
    assert.match(output, /^OPENAI_BASE_URL='https:\/\/proxy\.example\/line1\\nline2\\r\\nline3'$/m);
    assert.equal(output.trimEnd().split('\n').length, 1);

    const sourced = execFileSync('sh', ['-lc', `set -a; . "${envFile}"; printf '%s' "$OPENAI_BASE_URL"`], {
      encoding: 'utf8',
    }).trim();
    assert.equal(sourced, 'https://proxy.example/line1\\nline2\\r\\nline3');
  } finally {
    rmSync(envRoot, { recursive: true, force: true });
  }
});
