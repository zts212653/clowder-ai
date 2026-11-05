import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { dshLauncherProfileState } from '../dist/routes/native-dsh-profile.js';
import { discoverNativeRuntimes } from '../dist/routes/native-runtimes.js';

test('runtime discovery identifies the DSH launcher rather than a DeepSeek provider argument', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-identity-'));
  const templatePath = join(root, 'cat-template.json');
  const packageRoot = join(root, 'official-install', 'dsh');
  const commonRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const entry = join(packageRoot, 'lib', 'bin.js');
  const commonEntry = join(commonRoot, 'lib', 'bin.js');
  [packageRoot, commonRoot].forEach((directory) => {
    mkdirSync(join(directory, 'lib'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
    writeFileSync(join(directory, 'lib', 'bin.js'), '');
  });
  mkdirSync(join(root, 'profiles', 'acp'), { recursive: true });
  writeFileSync(
    join(root, 'profiles', 'acp', 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const members = [
    { id: 'dsh-identity-real', displayName: 'Real', command: 'dsh.cmd', startupArgs: ['--profile', 'acp'] },
    {
      id: 'dsh-identity-custom',
      displayName: 'Custom ACP',
      command: 'custom-acp',
      startupArgs: ['--provider', 'deepseek'],
    },
    {
      id: 'dsh-identity-package',
      displayName: 'Official package',
      command: process.execPath,
      startupArgs: [entry, '--profile', 'acp'],
    },
    {
      id: 'dsh-identity-standard-package',
      displayName: 'Common install',
      command: process.execPath,
      startupArgs: [commonEntry, '--profile', 'acp'],
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
    [
      ['dsh-identity-package', entry],
      ['dsh-identity-standard-package', commonEntry],
    ].forEach(([id, packageEntry]) => {
      assert.equal(dshLauncherProfileState(process.execPath, [packageEntry, '--profile', 'acp'], root), 'configured');
      const official = runtimes.find((runtime) => runtime.id === `acp:${id}`);
      assert.equal(official?.label, 'DSH');
      assert.equal(official?.installed, true);
      assert.equal(official?.discoveryStatus, 'configured');
      assert.deepEqual(official?.acp, {
        command: process.execPath,
        startupArgs: [packageEntry, '--profile', 'acp'],
        transport: undefined,
      });
    });
  } finally {
    saved.forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
