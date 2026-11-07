import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { resolveDshSetupLaunch } from '../dist/routes/dsh-setup-launch.js';
import { discoverNativeRuntimes } from '../dist/routes/native-runtimes.js';

test('runtime discovery identifies the DSH launcher rather than a DeepSeek provider argument', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-identity-'));
  const templatePath = join(root, 'cat-template.json');
  const members = [
    { id: 'dsh-identity-real', displayName: 'Real', command: 'dsh.cmd', startupArgs: ['--profile', 'acp'] },
    {
      id: 'dsh-identity-custom',
      displayName: 'Custom ACP',
      command: 'custom-acp',
      startupArgs: ['--provider', 'deepseek'],
    },
  ];
  writeFileSync(
    templatePath,
    JSON.stringify({
      version: 2,
      breeds: members.map((member) => ({
        catId: member.id,
        variants: [{ catId: member.id, acp: { command: member.command, startupArgs: member.startupArgs } }],
      })),
    }),
  );
  const base = catRegistry.tryGet('opus').config;
  members.forEach((member) => {
    catRegistry.register(
      member.id,
      { ...base, id: member.id, displayName: member.displayName, clientId: 'acp', agentProvider: undefined },
      { configurationTemplatePath: templatePath },
    );
  });
  const keys = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'];
  const saved = keys.map((key) => [key, process.env[key]]);
  keys.forEach((key) => {
    process.env[key] = root;
  });
  try {
    const { runtimes } = discoverNativeRuntimes(root, () => process.execPath);
    assert.equal(runtimes.find((runtime) => runtime.id === 'acp:dsh-identity-real')?.label, 'DSH');
    assert.equal(runtimes.find((runtime) => runtime.id === 'acp:dsh-identity-custom')?.label, 'Custom ACP');
  } finally {
    saved.forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('registered DSH profile status verifies package identity outside node_modules without trusting its label', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-verified-entry-'));
  const savedHome = process.env.DSH_HOME;
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, 'profiles', 'acp'), { recursive: true });
    writeFileSync(
      join(home, 'profiles', 'acp', 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
    );
    process.env.DSH_HOME = home;
    const members = [
      { id: 'dsh-verified-official', packageName: '@deepseek-ai/dsh', extra: [] },
      { id: 'dsh-verified-lookalike', packageName: 'custom-acp', extra: [] },
      { id: 'dsh-verified-patched', packageName: '@deepseek-ai/dsh', extra: ['--patch', join(root, 'custom.yml')] },
      { id: 'dsh-verified-custom', packageName: '@deepseek-ai/dsh', extra: ['--custom'] },
    ].map((member) => {
      const pkg = join(root, member.id, 'dsh');
      mkdirSync(join(pkg, 'lib'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: member.packageName }));
      const entry = join(pkg, 'lib', 'bin.js');
      writeFileSync(entry, '');
      return { ...member, acp: { command: 'node', startupArgs: [entry, '--profile', 'acp', ...member.extra] } };
    });
    const templatePath = join(root, 'cat-template.json');
    writeFileSync(
      templatePath,
      JSON.stringify({
        version: 2,
        breeds: members.map((member) => ({
          catId: member.id,
          variants: [{ catId: member.id, acp: member.acp }],
        })),
      }),
    );
    for (const member of members)
      catRegistry.register(
        member.id,
        {
          ...catRegistry.tryGet('opus').config,
          id: member.id,
          displayName: 'DSH',
          clientId: 'acp',
          agentProvider: undefined,
        },
        { configurationTemplatePath: templatePath },
      );
    const { runtimes } = discoverNativeRuntimes(root, () => process.execPath);
    const official = runtimes.find((runtime) => runtime.id === `acp:${members[0].id}`);
    const lookalike = runtimes.find((runtime) => runtime.id === `acp:${members[1].id}`);
    assert.equal(official?.discoveryStatus, 'configured');
    assert.equal(official?.installed, true);
    assert.equal(official?.dshSetupSupported, true);
    assert.deepEqual(official?.acp?.startupArgs, members[0].acp.startupArgs);
    assert.equal(
      resolveDshSetupLaunch('node', members[0].acp.startupArgs, root).args[0],
      members[0].acp.startupArgs[0],
    );
    assert.equal(lookalike?.label, 'DSH');
    assert.equal(lookalike?.discoveryStatus, undefined);
    assert.equal(lookalike?.dshSetupSupported, undefined);
    const patched = runtimes.find((runtime) => runtime.id === `acp:${members[2].id}`);
    assert.equal(patched?.discoveryStatus, undefined); // Preserve profile-discovery semantics.
    assert.equal(patched?.dshSetupSupported, true);
    assert.equal(patched?.label, 'DSH');
    assert.deepEqual(patched?.acp?.startupArgs, members[2].acp.startupArgs);
    assert.deepEqual(resolveDshSetupLaunch('node', members[2].acp.startupArgs, root).args, members[2].acp.startupArgs);
    assert.equal(runtimes.find((runtime) => runtime.id === `acp:${members[3].id}`)?.dshSetupSupported, undefined);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
});
