/**
 * Project env loader tests.
 *
 * The loader reapplies Hub-persisted app settings from the config-root .env
 * into process.env at boot, only-if-unset, scoped to the explicit app-setting
 * allowlist in config/app-settings.ts.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadProjectEnvIntoProcess, parseEnvFileContents } from '../dist/config/project-env-loader.js';

const SCRATCH = [];

/**
 * Every env key these tests may touch. Capability/permission keys are included
 * on purpose: the negative tests must prove the loader leaves them alone.
 */
const TRACKED_ENV_KEYS = [
  'CAT_CAFE_CONFIG_ROOT',
  'DEFAULT_CAT_ID',
  'UI_BUBBLE_CLI_OUTPUT_DEFAULT',
  'UI_BUBBLE_THINKING_DEFAULT',
  'PROMPT_CAPTURE',
  'PROMPT_CAPTURE_CATS',
  'CAT_CODEX_SANDBOX_MODE',
  'CAT_CODEX_APPROVAL_POLICY',
  'CODEX_AUTH_MODE',
  'CAT_CODEX_EXEC_MODEL',
  'CAT_CODEX_PASS_MODEL_ARG',
  'CLI_TIMEOUT_MS',
  'MAX_A2A_DEPTH',
  'CONNECTOR_GATEWAY_AUTOSTART',
];

function makeConfigRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-project-env-'));
  SCRATCH.push(dir);
  return dir;
}

afterEach(() => {
  while (SCRATCH.length > 0) rmSync(SCRATCH.pop(), { recursive: true, force: true });
});

describe('parseEnvFileContents', () => {
  it('parses plain KEY=VALUE lines', () => {
    const entries = parseEnvFileContents('DEFAULT_CAT_ID=research\nCLI_TIMEOUT_MS=1000');
    assert.deepEqual(entries, [
      { name: 'DEFAULT_CAT_ID', value: 'research' },
      { name: 'CLI_TIMEOUT_MS', value: '1000' },
    ]);
  });

  it('ignores comments, blank lines, and lines without =', () => {
    const entries = parseEnvFileContents('# comment\n\nDEFAULT_CAT_ID=research\nBROKEN_LINE\n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'DEFAULT_CAT_ID');
  });

  it('strips surrounding quotes and CRLF', () => {
    const entries = parseEnvFileContents('GREETING="hello, world"\r\nOTHER=\'single\'\r\n');
    assert.deepEqual(entries, [
      { name: 'GREETING', value: 'hello, world' },
      { name: 'OTHER', value: 'single' },
    ]);
  });
});

describe('loadProjectEnvIntoProcess', () => {
  const saved = new Map();

  beforeEach(() => {
    saved.clear();
    for (const key of TRACKED_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function useConfigRoot(root) {
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    return join(root, '.env');
  }

  it('applies app settings from the config-root .env when unset', () => {
    const envFile = useConfigRoot(makeConfigRoot());
    writeFileSync(
      envFile,
      [
        'DEFAULT_CAT_ID=research',
        'UI_BUBBLE_CLI_OUTPUT_DEFAULT=expanded',
        'UI_BUBBLE_THINKING_DEFAULT=expanded',
        'PROMPT_CAPTURE=on',
        '',
      ].join('\n'),
    );

    const result = loadProjectEnvIntoProcess();

    assert.equal(process.env.DEFAULT_CAT_ID, 'research');
    assert.equal(process.env.UI_BUBBLE_CLI_OUTPUT_DEFAULT, 'expanded');
    assert.equal(process.env.UI_BUBBLE_THINKING_DEFAULT, 'expanded');
    assert.equal(process.env.PROMPT_CAPTURE, 'on');
    assert.deepEqual([...result.applied].sort(), [
      'DEFAULT_CAT_ID',
      'PROMPT_CAPTURE',
      'UI_BUBBLE_CLI_OUTPUT_DEFAULT',
      'UI_BUBBLE_THINKING_DEFAULT',
    ]);
    assert.equal(result.envFile, envFile);
  });

  it('skips keys already set in the process (launcher wins)', () => {
    const envFile = useConfigRoot(makeConfigRoot());
    process.env.DEFAULT_CAT_ID = 'codex';
    writeFileSync(envFile, 'DEFAULT_CAT_ID=research\n');

    const result = loadProjectEnvIntoProcess();

    assert.equal(process.env.DEFAULT_CAT_ID, 'codex', 'existing process value must not be clobbered');
    assert.ok(result.skipped.includes('DEFAULT_CAT_ID'));
    assert.equal(result.applied.includes('DEFAULT_CAT_ID'), false);
  });

  it('does not restore capability or permission keys from the config-root .env', () => {
    const envFile = useConfigRoot(makeConfigRoot());
    const forbidden = [
      'CAT_CODEX_SANDBOX_MODE=danger-full-access',
      'CAT_CODEX_APPROVAL_POLICY=never',
      'CODEX_AUTH_MODE=api_key',
      'CAT_CODEX_EXEC_MODEL=gpt-5.3-codex',
      'CAT_CODEX_PASS_MODEL_ARG=true',
      'CONNECTOR_GATEWAY_AUTOSTART=1',
    ];
    writeFileSync(envFile, `${forbidden.join('\n')}\n`);

    const result = loadProjectEnvIntoProcess();

    for (const line of forbidden) {
      const name = line.slice(0, line.indexOf('='));
      assert.equal(process.env[name], undefined, `${name} must not be restored at boot`);
      assert.equal(result.applied.includes(name), false, `${name} must not be reported as applied`);
      assert.equal(result.skipped.includes(name), false, `${name} must not even be considered eligible`);
    }
  });

  it('leaves a launcher-provided permission key untouched while restoring app settings', () => {
    const envFile = useConfigRoot(makeConfigRoot());
    process.env.CAT_CODEX_APPROVAL_POLICY = 'on-request'; // launcher-owned posture
    writeFileSync(envFile, 'CAT_CODEX_APPROVAL_POLICY=never\nDEFAULT_CAT_ID=research\n');

    loadProjectEnvIntoProcess();

    assert.equal(process.env.CAT_CODEX_APPROVAL_POLICY, 'on-request', 'permission posture must stay launcher-owned');
    assert.equal(process.env.DEFAULT_CAT_ID, 'research');
  });

  it('does not persist-eligible runtime parameters that are not app settings', () => {
    const envFile = useConfigRoot(makeConfigRoot());
    writeFileSync(envFile, 'CLI_TIMEOUT_MS=1000\nMAX_A2A_DEPTH=3\n');

    const result = loadProjectEnvIntoProcess();

    assert.equal(process.env.CLI_TIMEOUT_MS, undefined);
    assert.equal(process.env.MAX_A2A_DEPTH, undefined);
    assert.deepEqual(result.applied, []);
  });

  it('returns an empty result when the config-root .env is absent', () => {
    useConfigRoot(makeConfigRoot());

    const result = loadProjectEnvIntoProcess();

    assert.equal(result.envFile, null);
    assert.deepEqual(result.applied, []);
  });
});
