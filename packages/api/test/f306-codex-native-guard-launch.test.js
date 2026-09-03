import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const guardLaunchModule = import('../dist/domains/cats/services/agents/providers/CodexNativeEffectGuard.js');
const serviceModule = import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');

describe('F306 AC-C7 Codex native guard launch contract', () => {
  test('builds one exact-trusted hook contract for exec and app-server carriers', async () => {
    const { buildCodexNativeEffectGuardArgs, CODEX_NATIVE_GUARD_HOOK_KEY, nativeEffectGuardHookHash } =
      await guardLaunchModule;
    const { buildCodexAppServerArgs } = await serviceModule;
    const args = buildCodexNativeEffectGuardArgs();

    assert.deepEqual(args.filter((value) => value === '--config').length, 2);
    assert.ok(args.includes('features.hooks=true'));
    const hookConfig = args.find((value) => value.startsWith('hooks='));
    assert.ok(hookConfig, 'launcher must inject inline hooks config');
    assert.match(hookConfig, /PreToolUse/);
    assert.match(hookConfig, /Bash\|Edit\|Write/);
    assert.match(hookConfig, /native-effect-target-guard\.mjs/);
    assert.match(hookConfig, /trusted_hash="sha256:[a-f0-9]{64}"/);
    assert.match(hookConfig, new RegExp(CODEX_NATIVE_GUARD_HOOK_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!args.includes('--dangerously-bypass-hook-trust'));
    assert.equal(
      nativeEffectGuardHookHash("'/usr/bin/node' '/repo/scripts/native-effect-target-guard.mjs'"),
      'sha256:35eb8ec31f6cfb7363a2fd9fcae98e87fb04e805f708600f20f220370d156cc2',
    );

    const appServer = buildCodexAppServerArgs(args);
    assert.equal(appServer[0], 'app-server');
    assert.ok(appServer.includes('features.hooks=true'));
    assert.ok(appServer.some((value) => value.startsWith('hooks=')));
  });

  test('recognizes every user override spelling that could disable or replace the guard', async () => {
    const { stripReservedCodexSystemConfigs } = await serviceModule;
    const unsafe = [
      '--config',
      'hooks={}',
      '-c',
      'hooks.PreToolUse=[]',
      '--config=features.hooks=false',
      '-cfeatures={hooks=false}',
      '--disable',
      'hooks',
      '--disable=hooks',
      '--dangerously-bypass-hook-trust',
      '--config',
      'model_verbosity="high"',
    ];
    const filtered = stripReservedCodexSystemConfigs(unsafe, 'codex-sol');

    assert.deepEqual(filtered, ['--config', 'model_verbosity="high"']);
  });
});
