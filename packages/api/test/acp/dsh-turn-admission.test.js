import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import {
  prepareDshTurnPatch,
  verifyDshTurnPatch,
} from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-turn-patch.js';

const selection = '["deepseek-official","deepseek-flash"]';

function desktopFixture() {
  const root = mkdtempSync(join(tmpdir(), 'issue1947-turn-admission-'));
  const command = join(root, 'desktop/resources/runtime/cli/bin/dsh.cmd');
  const manifest = join(root, 'desktop/resources/runtime/primary-runtime/runtime.json');
  mkdirSync(dirname(command), { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    command,
    [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
      'exit /b %errorlevel%',
    ].join('\n'),
    { mode: 0o700 },
  );
  writeFileSync(join(root, 'desktop/DeepSeek Harness.exe'), '');
  writeFileSync(join(root, 'desktop/resources/app.asar'), '');
  writeFileSync(manifest, JSON.stringify({ desktopVersion: '0.2.2-rc.1' }));
  return { root, command, manifest };
}

test('an admitted factory pool rechecks Desktop version before each cold client', async (t) => {
  const { root, command, manifest } = desktopFixture();
  const pools = new Map();
  const services = [];
  const compatibility = process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
  if (process.platform === 'win32') process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
  t.after(async () => {
    if (compatibility === undefined) delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
    else process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = compatibility;
    await Promise.all(services.map((service) => service.disposeHostService()));
    await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
  });
  const input = {
    projectRoot: root,
    bootstrapRoot: join(root, 'bootstrap'),
    profileId: 'dsh-turn-admission',
    effectiveModel: selection,
    acpConfig: { command, startupArgs: ['--profile', 'acp'] },
    poolRegistry: pools,
    log: { info() {}, warn() {} },
    config: {
      id: 'dsh-turn-admission',
      name: 'DSH',
      displayName: 'DSH',
      clientId: 'acp',
      configurationSource: 'native_tool',
      mcpSupport: false,
      color: { primary: '#111111', secondary: '#eeeeee' },
      avatar: '/fixture.png',
      mentionPatterns: ['@dsh-turn-admission'],
      roleDescription: 'isolated cold-start admission fixture',
    },
  };
  const admitted = await createAcpServiceForConfig(input);
  assert.ok(admitted);
  services.push(admitted);
  assert.equal(admitted.freshnessCarrierCapability().deliverySemantics, 'exact_active_turn');
  const pool = pools.get(input.profileId);
  assert.ok(pool);
  const client = pool.clientFactory();
  assert.match(client.config.args.at(-1), /dsh-turn-.*\.patch\.yml$/);

  for (const [label, content] of [
    ['rc.2', JSON.stringify({ desktopVersion: '0.2.2-rc.2' })],
    ['unknown version', JSON.stringify({ desktopVersion: 'unknown' })],
    ['missing version', '{}'],
    ['invalid JSON', '{'],
    ['missing manifest', null],
  ]) {
    await t.test(label, () => {
      if (content === null) unlinkSync(manifest);
      else writeFileSync(manifest, content);
      assert.throws(() => pool.clientFactory(), /dsh_turn_admission_changed:.*refresh this member/);
      if (process.platform === 'win32') {
        assert.throws(
          () =>
            client.config.verifyBootstrapCwd(
              client.config.preparedSpawn.command,
              [...client.config.preparedSpawn.args],
              client.config.preparedEnv,
            ),
          /dsh_turn_admission_changed:.*refresh this member/,
          'the Windows pre-spawn callback must reject the same drift',
        );
      }
    });
    writeFileSync(manifest, JSON.stringify({ desktopVersion: '0.2.2-rc.1' }));
    assert.doesNotThrow(() => pool.clientFactory(), 'restored rc.1 remains admitted');
  }

  const patch = client.config.args.at(-1);
  const originalPatch = readFileSync(patch, 'utf8');
  writeFileSync(patch, originalPatch.replace('deepseek-flash', 'other-model'));
  assert.throws(() => pool.clientFactory(), /dsh_turn_admission_changed:.*managed bridge patch changed/);
  writeFileSync(patch, originalPatch);
  assert.doesNotThrow(() => pool.clientFactory(), 'restoring the managed patch restores admission');

  writeFileSync(manifest, JSON.stringify({ desktopVersion: '0.2.2-rc.2' }));
  const ordinary = await createAcpServiceForConfig(input);
  assert.ok(ordinary);
  services.push(ordinary);
  assert.notEqual(pools.get(input.profileId), pool);
  assert.equal(ordinary.freshnessCarrierCapability().deliverySemantics, 'unsupported');
  assert.ok(
    !pools
      .get(input.profileId)
      .clientFactory()
      .config.args.some((arg) => /dsh-turn-.*\.patch\.yml$/.test(arg)),
  );
  // No Electron/model is started; retain only isolated fixture state for failure diagnosis.
});

test('a turn patch cannot be reused for another supported Desktop installation', async () => {
  const original = desktopFixture();
  const replacement = desktopFixture();
  const args = ['--profile', 'acp'];
  const prepared = await prepareDshTurnPatch(original.command, args, original.root, selection);
  const patch = prepared.at(-1);
  assert.equal(verifyDshTurnPatch(patch, original.command, args), true);
  assert.equal(verifyDshTurnPatch(patch, replacement.command, args), false);
  assert.equal(verifyDshTurnPatch(patch, original.command, args), true, 'the old rc.1 installation still exists');
});
