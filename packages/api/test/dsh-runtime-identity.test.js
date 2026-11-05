import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
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
