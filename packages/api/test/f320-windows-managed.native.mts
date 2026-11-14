import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertCodexManagedPlatformSupport } from '../src/config/codex-managed-support.js';
import { codexNativeCapabilityVerdict } from '../src/infrastructure/codex-native-compat/admission.js';
import { readCodexNativeVersion } from '../src/infrastructure/codex-native-compat/native-version.js';
import { probeEnvironment } from '../src/infrastructure/codex-native-compat/probe-host.js';
import { resolveCliCommand } from '../src/utils/cli-resolve.js';

// Opt-in installed CLI measurement. No OAuth login, browser, real credentials or remote model requests.
test(
  'installed Windows Codex passes managed-account measurement in temporary homes',
  {
    skip: process.platform !== 'win32' || process.env.F320_NATIVE_WINDOWS_TEST !== '1',
    timeout: 180_000,
  },
  async () => {
    const command = resolveCliCommand('codex');
    assert.ok(command, 'install an official Codex CLI before opting in');
    assert.ok(process.env.HOME, 'run through scripts/with-test-home.mjs');
    const version = await readCodexNativeVersion(command, probeEnvironment(process.env.HOME));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = join(process.env.HOME, 'data');
    try {
      const failure = await assertCodexManagedPlatformSupport(process.env.HOME, command).then(
        () => undefined,
        (error: Error) => error,
      );
      const report = await codexNativeCapabilityVerdict(command, 'managed_accounts', version);
      console.log(JSON.stringify(report));
      assert.equal(failure, undefined, JSON.stringify(report.checks.filter((check) => !check.ok)));
      assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => !check.ok)));
    } finally {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
    }
  },
);
