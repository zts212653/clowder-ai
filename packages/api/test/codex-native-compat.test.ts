import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateCodexOAuthConfig, validateCodexOwnedProvider } from '../src/config/codex-account-environment.js';
import { withoutUnreviewedCodexEnvironment } from '../src/config/codex-env-namespace.js';
import { assertCodexManagedPlatformSupport } from '../src/config/codex-managed-support.js';
import {
  admitCodexNativeCapability,
  codexCompatVerdictPath,
  setCodexNativeProbeForTest,
} from '../src/infrastructure/codex-native-compat/admission.js';
import { resetCodexNativeVersionCache } from '../src/infrastructure/codex-native-compat/native-version.js';
import {
  CODEX_COMPAT_PROBE_REVISION,
  type CodexCompatReport,
  type CodexNativeCapability,
  probeCodexNativeCapability,
} from '../src/infrastructure/codex-native-compat/probe.js';

const savedDataDir = process.env.CAT_CAFE_DATA_DIR;
afterEach(() => {
  setCodexNativeProbeForTest(undefined);
  resetCodexNativeVersionCache();
  if (savedDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
  else process.env.CAT_CAFE_DATA_DIR = savedDataDir;
});

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-compat-')));
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
  const binary = join(root, 'codex');
  const calls = join(root, 'version-calls');
  const install = (version: string, delaySeconds = 0) => {
    // A rewrite is what an npm/Homebrew upgrade does: new inode, new version string.
    rmSync(binary, { force: true });
    writeFileSync(
      binary,
      `#!/bin/sh\necho x >> '${calls}'\nsleep ${delaySeconds}\nprintf 'codex-cli ${version}\\n'\n`,
      { mode: 0o700 },
    );
  };
  const versionCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0);
  return { root, binary, install, versionCalls, close: () => rmSync(root, { recursive: true, force: true }) };
}

function stubProbe(outcome: (capability: CodexNativeCapability, version: string) => boolean, failedCheck = 'layout.x') {
  const seen: string[] = [];
  setCodexNativeProbeForTest(async (_binary, capability, version): Promise<CodexCompatReport> => {
    seen.push(`${capability}:${version}`);
    const ok = outcome(capability, version);
    return {
      capability,
      version,
      probeRevision: CODEX_COMPAT_PROBE_REVISION,
      checkedAt: new Date().toISOString(),
      ok,
      checks: [{ id: ok ? 'layout.ok' : failedCheck, ok }],
    };
  });
  return seen;
}
const ENV = { PATH: process.env.PATH };

test('a version never seen before is measured once, then admitted from its recorded verdict', async () => {
  const s = sandbox();
  try {
    s.install('9.9.9');
    const seen = stubProbe(() => true);
    assert.equal(await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'), 'codex-cli 9.9.9');
    assert.equal(await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'), 'codex-cli 9.9.9');
    assert.deepEqual(seen, ['managed_accounts:codex-cli 9.9.9']);
    const path = codexCompatVerdictPath('managed_accounts', 'codex-cli 9.9.9', join(s.root, 'data'));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).ok, true);
    // A restarted API (fresh memory) reads the recorded verdict instead of measuring again.
    const after = stubProbe(() => true);
    resetCodexNativeVersionCache();
    await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e');
    assert.deepEqual(after, []);
  } finally {
    s.close();
  }
});

test('a failed measurement rejects with the version and failed check, and records the evidence', async () => {
  const s = sandbox();
  try {
    s.install('9.9.10');
    const seen = stubProbe(() => false, 'layout.single_writer_across_homes');
    await assert.rejects(
      admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'codex_managed_version_unverified'),
      /^Error: codex_managed_version_unverified:codex-cli 9\.9\.10:layout\.single_writer_across_homes$/,
    );
    // Immediate retries reuse the recent failure instead of re-running a native probe per launch.
    await assert.rejects(admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'));
    assert.equal(seen.length, 1);
    const path = codexCompatVerdictPath('managed_accounts', 'codex-cli 9.9.10', join(s.root, 'data'));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).ok, false);
    // A recorded failure never admits: after a restart the version is measured again.
    const again = stubProbe(() => true);
    assert.equal(await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'), 'codex-cli 9.9.10');
    assert.equal(again.length, 1);
  } finally {
    s.close();
  }
});

test('a failure caught mid-install is measured again as soon as the installed files change', async () => {
  const s = sandbox();
  try {
    s.install('9.9.20');
    const seen = stubProbe(() => seen.length > 1);
    await assert.rejects(admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'));
    await assert.rejects(admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'));
    assert.equal(seen.length, 1, 'same files: the recent failure is reused');
    // npm finishes swapping files: same version string, new install identity.
    s.install('9.9.20');
    assert.equal(await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'), 'codex-cli 9.9.20');
    assert.equal(seen.length, 2);
  } finally {
    s.close();
  }
});

test('capabilities are admitted independently, and a verdict from an older probe is measured again', async () => {
  const s = sandbox();
  try {
    s.install('9.9.11');
    const path = codexCompatVerdictPath('readonly_sandbox', 'codex-cli 9.9.11', join(s.root, 'data'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        capability: 'readonly_sandbox',
        version: 'codex-cli 9.9.11',
        probeRevision: 0,
        ok: true,
        checks: [],
      }),
    );
    const seen = stubProbe((capability) => capability === 'readonly_sandbox');
    await admitCodexNativeCapability(s.binary, 'readonly_sandbox', ENV, 'e');
    await assert.rejects(admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'), /^Error: e:/);
    assert.deepEqual(seen, ['readonly_sandbox:codex-cli 9.9.11', 'managed_accounts:codex-cli 9.9.11']);
  } finally {
    s.close();
  }
});

test('concurrent launches after an upgrade share one measurement', async () => {
  const s = sandbox();
  try {
    s.install('9.9.12');
    const seen = stubProbe(() => true);
    await Promise.all(
      Array.from({ length: 6 }, () => admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e')),
    );
    assert.equal(seen.length, 1);
    assert.equal(s.versionCalls(), 1);
  } finally {
    s.close();
  }
});

test('a slow first --version no longer times out, and an unchanged install is not spawned again', async () => {
  const s = sandbox();
  try {
    s.install('9.9.13', 3);
    stubProbe(() => true);
    await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e');
    await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e');
    assert.equal(s.versionCalls(), 1);
  } finally {
    s.close();
  }
});

test('upgrading the installed binary re-reads its version and measures the new one', async () => {
  const s = sandbox();
  try {
    s.install('9.9.14');
    const seen = stubProbe(() => true);
    await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e');
    s.install('9.9.15');
    assert.equal(await admitCodexNativeCapability(s.binary, 'managed_accounts', ENV, 'e'), 'codex-cli 9.9.15');
    assert.deepEqual(seen, ['managed_accounts:codex-cli 9.9.14', 'managed_accounts:codex-cli 9.9.15']);
  } finally {
    s.close();
  }
});

test('managed env keeps only our own CODEX_* fields, whatever knobs a newer Codex adds', () => {
  const env = withoutUnreviewedCodexEnvironment(
    {
      CODEX_HOME: '/managed/home',
      CODEX_SQLITE_HOME: '/state',
      CODEX_AUTH_MODE: 'oauth',
      CODEX_CAT_ACCOUNT_REF: 'codex-x',
      CODEX_APP_SERVER_CHATGPT_BASE_URL: 'https://account-env.invalid',
      PATH: '/usr/bin',
    },
    { OPENAI_CLUSTER: 'inherited', CODEX_FUTURE_TOKEN: 'inherited', HOME: '/home' },
  );
  assert.deepEqual(env, {
    CODEX_HOME: '/managed/home',
    CODEX_SQLITE_HOME: '/state',
    CODEX_AUTH_MODE: 'oauth',
    CODEX_CAT_ACCOUNT_REF: 'codex-x',
    CODEX_APP_SERVER_CHATGPT_BASE_URL: null,
    PATH: '/usr/bin',
    OPENAI_CLUSTER: null,
    CODEX_FUTURE_TOKEN: null,
  });
});

test('the unset provider field 0.164.0 serializes is accepted; a set value still conflicts', () => {
  const owned = { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };
  validateCodexOwnedProvider({ ...owned, capabilities: null });
  assert.throws(
    () => validateCodexOwnedProvider({ ...owned, capabilities: { web_search: true } }),
    /codex_oauth_configuration_conflict:model_providers\.openai_https\.capabilities/,
  );
  assert.throws(
    () => validateCodexOAuthConfig({ chatgpt_base_url: 'https://elsewhere.invalid/' }),
    /codex_oauth_configuration_conflict:chatgpt_base_url/,
  );
});

// Real installed carrier: the measurement itself, credential-free (temp homes, loopback model).
let installedCodex: string | undefined;
try {
  installedCodex = execFileSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim() || undefined;
} catch {
  installedCodex = undefined;
}
const native = { skip: process.platform !== 'darwin' || !installedCodex, timeout: 180_000 };

for (const capability of ['managed_accounts', 'readonly_sandbox'] as const)
  test(`installed Codex passes the ${capability} measurement`, native, async () => {
    const version = execFileSync(installedCodex!, ['--version'], { encoding: 'utf8' }).trim();
    const report = await probeCodexNativeCapability(installedCodex!, capability, version);
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((entry) => !entry.ok)));
    const expected =
      capability === 'managed_accounts'
        ? [
            'auth.no_host_login_fallback',
            'layout.single_writer_across_homes',
            'layout.continuity_across_homes',
            'layout.native_memory_across_homes',
            'layout.list_revert_archive',
            'layout.cold_resume',
            'layout.shared_persistence',
            'layout.native_config_writer_shared',
            'transport.no_authorization_header',
            'config.user-relative',
            'config.symlink-relative',
            'config.project-untrusted',
            'config.project-trusted',
            'config.owned-https',
          ]
        : ['readonly.exec_runs', 'readonly.write_denied', 'readonly.network_denied'];
    assert.deepEqual(
      report.checks.map((entry) => entry.id),
      expected,
    );
  });

test('the installed Codex is admitted for managed accounts on this machine', native, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-admit-')));
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
  try {
    await assertCodexManagedPlatformSupport(join(root, 'home'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
