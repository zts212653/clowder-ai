// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { flattenAcpPrompt, zcodeLaunchPlan } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/zcode-acp-adapter.js'
);
const {
  isZcodeHarnessCommand,
  zcodeOmitsAcpSessionMcp,
  prepareZcodeAcpSpawn,
  resolveZcodeAcpAdapterPath,
  resolveZcodeBin,
  diagnoseZcodeSpawnReady,
} = await import('../../dist/domains/cats/services/agents/providers/acp/zcode-acp-bootstrap.js');

describe('ZCode ACP bootstrap', () => {
  it('treats zcode as a harness that omits session MCP', () => {
    assert.equal(isZcodeHarnessCommand('zcode'), true);
    assert.equal(isZcodeHarnessCommand('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'), true);
    assert.equal(isZcodeHarnessCommand('dsh'), false);
    assert.equal(zcodeOmitsAcpSessionMcp('zcode'), true);
    assert.equal(zcodeOmitsAcpSessionMcp('grok'), false);
  });

  it('skips when the ZCode binary is missing', () => {
    const spawn = prepareZcodeAcpSpawn({
      command: 'zcode',
      env: { CAT_CAFE_ZCODE_IGNORE_BUNDLED: '1', PATH: '/tmp/empty-path' },
    });
    assert.equal(spawn.ok, false);
    if (!spawn.ok) assert.match(spawn.error.message, /zcode CLI 未找到|ZCode/);
  });

  it('rewrites spawn to node + in-repo adapter when CAT_CAFE_ZCODE_BIN exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-bin-'));
    const bin = join(dir, 'zcode.cjs');
    writeFileSync(bin, '#!/usr/bin/env node\n');
    try {
      const isolatedHome = join(dir, 'isolated-home');
      const spawn = prepareZcodeAcpSpawn({
        command: 'zcode',
        env: {
          CAT_CAFE_ZCODE_BIN: bin,
          CAT_CAFE_ZCODE_IGNORE_BUNDLED: '1',
          CAT_CAFE_ZCODE_HOME: isolatedHome,
        },
      });
      assert.equal(spawn.ok, true);
      if (!spawn.ok) return;
      assert.equal(spawn.command, process.execPath);
      assert.equal(spawn.args[0], resolveZcodeAcpAdapterPath());
      assert.equal(spawn.env.ZCODE_BIN, bin);
      assert.equal(spawn.bin, bin);
      assert.equal(spawn.env.CAT_CAFE_ZCODE_HOME, isolatedHome);
      assert.notEqual(spawn.env.CAT_CAFE_ZCODE_HOME, homedir());
      assert.equal(statSync(spawn.env.CAT_CAFE_ZCODE_HOME).mode & 0o777, 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flattens ACP prompt blocks and launches app-server, not the TUI', () => {
    assert.equal(flattenAcpPrompt([{ type: 'text', text: 'PONG' }]), 'PONG');
    const plan = zcodeLaunchPlan('/tmp/zcode.cjs');
    assert.equal(plan.command, process.execPath);
    assert.deepEqual(plan.args, ['/tmp/zcode.cjs', 'app-server', '--surface', 'terminal', '--mode', 'yolo']);
  });

  it('does not treat an explicit missing CAT_CAFE_ZCODE_BIN as bundled success in ignore mode', () => {
    assert.equal(resolveZcodeBin({ CAT_CAFE_ZCODE_IGNORE_BUNDLED: '1', PATH: '/tmp/empty-path' }, []), undefined);
  });

  it('fail-closes when ZCODE_MODEL or provider credential is missing', () => {
    const noModel = diagnoseZcodeSpawnReady({ ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(noModel.ok, false);
    if (!noModel.ok) assert.match(noModel.error.message, /ZCODE_MODEL/);
    const noKey = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'GLM-5.2' });
    assert.equal(noKey.ok, false);
    if (!noKey.ok) assert.match(noKey.error.message, /ANTHROPIC_API_KEY/);
    const ready = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'GLM-5.2', ZCODE_API_KEY: 'sk-test' });
    assert.equal(ready.ok, true);
    const slash = diagnoseZcodeSpawnReady({ ZCODE_MODEL: 'zai/glm-5.2', ZCODE_API_KEY: 'sk-test' });
    assert.equal(slash.ok, false);
    if (!slash.ok) assert.match(slash.error.message, /clean-home|GLM-5\.2|zai\/glm-5\.2/);
  });
});
