import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readCodexLaunchProjection } from '../src/config/codex-launch-config.js';
import { createCodexTerminalLoginDriver } from '../src/config/codex-login-driver.js';
import { assertCodexManagedPlatformSupport } from '../src/config/codex-managed-support.js';

for (const source of ['native-managed', 'attempt-managed', 'system-requirements']) {
  test(
    `Windows managed admission preserves ${source} policy before version probing`,
    { skip: process.platform !== 'win32' },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'f320-windows-policy-'));
      const savedHome = process.env.CODEX_HOME;
      const savedProgramData = process.env.ProgramData;
      const nativeHome = join(root, 'native');
      const attempt = join(root, 'attempt');
      process.env.CODEX_HOME = nativeHome;
      process.env.ProgramData = join(root, 'system');
      const file =
        source === 'system-requirements'
          ? join(process.env.ProgramData, 'OpenAI', 'Codex', 'requirements.toml')
          : join(source === 'native-managed' ? nativeHome : attempt, 'managed_config.toml');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'allowed_approval_policies=["never"]\n');
      try {
        await assert.rejects(assertCodexManagedPlatformSupport(attempt), /codex_managed_policy_unsupported/);
      } finally {
        if (savedHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = savedHome;
        if (savedProgramData === undefined) delete process.env.ProgramData;
        else process.env.ProgramData = savedProgramData;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  'Windows launch projection reads its system, legacy managed and requirements layers',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'f320-windows-layers-'));
    const savedProgramData = process.env.ProgramData;
    process.env.ProgramData = join(root, 'program-data');
    const system = join(process.env.ProgramData, 'OpenAI', 'Codex');
    const home = join(root, 'private-home');
    mkdirSync(system, { recursive: true });
    mkdirSync(home);
    writeFileSync(join(system, 'config.toml'), 'model_provider="system-fixture"\n');
    writeFileSync(join(home, 'managed_config.toml'), 'forced_login_method="chatgpt"\n');
    writeFileSync(
      join(system, 'requirements.toml'),
      'allowed_login_methods=["chatgpt"]\nsqlite_home="required-state"\n',
    );
    try {
      const projection = readCodexLaunchProjection(home, root);
      assert.equal(projection.config.model_provider, 'system-fixture');
      assert.equal(projection.config.forced_login_method, 'chatgpt');
      assert.equal(projection.requirements.sqlite_home, join(system, 'required-state'));
      assert.deepEqual(projection.requirements.allowed_login_methods, ['chatgpt']);
      assert.equal(projection.layers.find((layer) => layer.kind === 'system')?.source, join(system, 'config.toml'));
    } finally {
      if (savedProgramData === undefined) delete process.env.ProgramData;
      else process.env.ProgramData = savedProgramData;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const [setting, expected] of [
  ['forced_login_method="api"', /codex_oauth_configuration_conflict:forced_login_method/],
  ['openai_base_url="https://fixture.invalid/v1"', /codex_oauth_configuration_conflict:openai_base_url/],
  ['model_provider="foreign"', /codex_oauth_configuration_conflict:model_provider/],
  ['invalid = [', /codex_account_config_invalid/],
] as const) {
  test(
    `Windows driver rejects incompatible system defaults before terminal startup (${setting})`,
    { skip: process.platform !== 'win32' },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'f320-system-login-'));
      const savedProgramData = process.env.ProgramData;
      process.env.ProgramData = join(root, 'program-data');
      const system = join(process.env.ProgramData, 'OpenAI', 'Codex');
      mkdirSync(system, { recursive: true });
      writeFileSync(join(system, 'config.toml'), setting);
      let opened = false;
      const driver = createCodexTerminalLoginDriver({
        command: process.execPath,
        assertSupport: () => {},
        openTerminal: async () => {
          opened = true;
          throw new Error('fixture-must-not-open');
        },
      });
      try {
        await assert.rejects(
          driver.run({
            home: join(root, 'attempt', 'home'),
            cwd: root,
            signal: new AbortController().signal,
            onReady: () => {},
          }),
          expected,
        );
        assert.equal(opened, false);
        assert.equal(existsSync(join(root, 'attempt', 'terminal-request.json')), false);
        assert.equal(existsSync(join(root, 'attempt', 'home', 'auth.json')), false);
      } finally {
        if (savedProgramData === undefined) delete process.env.ProgramData;
        else process.env.ProgramData = savedProgramData;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
