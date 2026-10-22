import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyAcpBootstrap } from '../../dist/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-context.js';
import { auditedWindowsAcpStartup } from '../../dist/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-startup-policy.js';

const windows = { skip: process.platform !== 'win32' };
const bridge = fileURLToPath(
  new URL('../../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js', import.meta.url),
);
const args = [bridge, '--pi-command', process.execPath];
const cleanEnv = { NODE_OPTIONS: '', NODE_PATH: '' };

test('only the exact built-in Pi bridge shape admits the volume policy', windows, () => {
  assert.equal(auditedWindowsAcpStartup(process.execPath, args, cleanEnv), 'builtin-pi');
  for (const invalid of [
    args.slice(0, 1),
    [...args, '--extension', 'unsafe.js'],
    ['--require', 'unsafe.js', ...args],
    [bridge, '--pi-command', 'pi'],
    [process.execPath, '--pi-command', process.execPath],
  ]) {
    assert.equal(auditedWindowsAcpStartup(process.execPath, invalid, cleanEnv), undefined);
  }
  for (const env of [
    { NODE_OPTIONS: '--require unsafe.js' },
    { NODE_PATH: 'unsafe' },
    { node_options: '--require unsafe.js' },
    { node_path: 'unsafe' },
  ]) {
    assert.equal(auditedWindowsAcpStartup(process.execPath, args, { ...cleanEnv, ...env }), undefined);
  }
});

test('Pi initialize completes without launching Pi or using ancestor instructions', windows, () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-pi-policy-'));
  try {
    const cwd = join(root, 'private');
    mkdirSync(cwd);
    writeFileSync(join(root, 'AGENTS.md'), 'UNTRUSTED_ANCESTOR_SENTINEL');
    mkdirSync(join(root, '.agents', 'skills', 'sentinel'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'sentinel', 'SKILL.md'), 'UNTRUSTED_ANCESTOR_SENTINEL');
    // A nonexistent Pi command makes any accidental early launch observable.
    const output = execFileSync(process.execPath, [bridge, '--pi-command', join(root, 'never-installed-pi.exe')], {
      cwd,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const response = JSON.parse(output.trim());
    assert.equal(response.result.agentInfo.name, 'clowder-pi-bridge');
    assert.equal(output.includes('UNTRUSTED_ANCESTOR_SENTINEL'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cold-start verification fails closed if the admitted startup environment changes', windows, () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-policy-recheck-'));
  const env = { ...cleanEnv };
  const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
  try {
    const context = verifyAcpBootstrap(
      { projectRoot: root, command: process.execPath, args, poolKey: { projectPath: root, providerProfile: 'pi' } },
      'pi',
      join(root, 'bootstrap'),
      env,
    );
    env.NODE_OPTIONS = '--require unsafe.js';
    assert.throws(() => context.verifyCwd(), /startup.*changed/i);
  } finally {
    if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
    else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'audited DSH default initialization and empty patch layers are admitted; custom layers are rejected',
  windows,
  (t) => {
    const entry = process.env.ACP_DSH_AUDITED_ENTRY;
    if (!entry) return t.skip('requires the audited DSH installation; never downloads or installs one');
    const home = mkdtempSync(join(tmpdir(), 'acp-dsh-policy-'));
    const env = { ...cleanEnv, DSH_HOME: home };
    const classify = (argv = ['--profile', 'acp']) => auditedWindowsAcpStartup(process.execPath, [entry, ...argv], env);
    try {
      assert.equal(classify(), 'dsh-0.2.0-rc.2', 'missing profile uses the audited official default');
      const profile = join(home, 'profiles', 'acp');
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, 'cordis.patch.yml'), '[]');
      assert.equal(classify(), undefined, 'a partial existing profile cannot silently become a default profile');
      rmSync(join(profile, 'cordis.patch.yml'));
      assert.equal(classify(), 'dsh-0.2.0-rc.2', 'an empty profile can be initialized from the audited template');
      writeFileSync(
        join(profile, 'package.json'),
        JSON.stringify({
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
            },
          },
        }),
      );
      const patch = join(profile, 'cordis.patch.yml');
      for (const empty of ['', '# default patch\n[]\n', '# comment only\n']) {
        writeFileSync(patch, empty);
        assert.equal(classify(), 'dsh-0.2.0-rc.2');
      }
      for (const invalid of ['- id: custom\n  name: ./unsafe.js', '!!js/function >\n  function() {}', '[broken']) {
        writeFileSync(patch, invalid);
        assert.equal(classify(), undefined);
      }
      rmSync(patch);
      for (const homeValue of ['relative-home', '~/.dsh']) {
        assert.equal(
          auditedWindowsAcpStartup(process.execPath, [entry, '--profile', 'acp'], { ...env, DSH_HOME: homeValue }),
          undefined,
        );
      }
      assert.equal(
        auditedWindowsAcpStartup(process.execPath, [entry, '--profile', 'acp'], {
          ...env,
          dsh_home: join(home, 'ambiguous'),
        }),
        undefined,
      );
      writeFileSync(join(home, 'cordis.patch.yml'), '- id: custom');
      assert.equal(classify(), undefined);
      rmSync(join(home, 'cordis.patch.yml'));
      writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['custom'] } } }));
      assert.equal(classify(), undefined);
      assert.equal(classify(['--profile', 'acp', '--patch', 'unsafe.yml']), undefined);
      const impostor = join(home, 'dsh-impostor.js');
      writeFileSync(impostor, '// an arbitrary third-party entry is not the audited DSH');
      assert.equal(auditedWindowsAcpStartup(process.execPath, [impostor, '--profile', 'acp'], env), undefined);
      assert.equal(existsSync(join(home, 'sessions')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
