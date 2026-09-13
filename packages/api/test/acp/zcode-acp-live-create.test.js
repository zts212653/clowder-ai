// @ts-check
/**
 * Real ZCode 0.16.3, no prompt. Proves clean-home session/create with
 * ZCODE_MODEL env (no native model field) and in-process session/load.
 * Dummy key only. Default skip: opt in with CAT_CAFE_ZCODE_LIVE=1, and
 * the binary must report exactly 0.16.3 or the live case fails closed.
 * Adapter restart persistence is covered by the fake store contract.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startAdapter } from './helpers/zcode-acp-test-harness.mjs';

const MAC_APP_ZCODE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const LINUX_APP_ZCODE = '/opt/ZCode/app/resources/glm/zcode.cjs';
const REQUIRED_ZCODE_VERSION = '0.16.3';

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
function isZcodeLiveCreateOptIn(env = process.env) {
  return env.CAT_CAFE_ZCODE_LIVE === '1';
}

/** @param {string | undefined | null} output */
function parseZcodeCliVersion(output) {
  const line = String(output ?? '')
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => /^\d+\.\d+\.\d+$/.test(row));
  return line;
}

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
function resolveZcodeLiveBin(env = process.env) {
  return [env.CAT_CAFE_ZCODE_BIN, MAC_APP_ZCODE, LINUX_APP_ZCODE].find((path) => path && existsSync(path));
}

/** @param {string} bin */
function readZcodeCliVersion(bin) {
  const useNode = /\.(cjs|js|mjs)$/.test(bin);
  const command = useNode ? process.execPath : bin;
  const args = useNode ? [bin, '--version'] : ['--version'];
  const home = mkdtempSync(join(tmpdir(), 'zcode-ver-'));
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 8_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
      },
    });
    return parseZcodeCliVersion(result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('ZCode ACP live-create gate', () => {
  it('requires explicit CAT_CAFE_ZCODE_LIVE=1 opt-in', () => {
    assert.equal(isZcodeLiveCreateOptIn({}), false);
    assert.equal(isZcodeLiveCreateOptIn({ CAT_CAFE_ZCODE_SKIP_LIVE: '1' }), false);
    assert.equal(isZcodeLiveCreateOptIn({ CAT_CAFE_ZCODE_BIN: MAC_APP_ZCODE }), false);
    assert.equal(isZcodeLiveCreateOptIn({ CAT_CAFE_ZCODE_LIVE: '1' }), true);
  });

  it('only treats an exact 0.16.3 --version line as protocol evidence', () => {
    assert.equal(parseZcodeCliVersion('0.16.3\n'), REQUIRED_ZCODE_VERSION);
    assert.equal(parseZcodeCliVersion('0.16.2\n'), '0.16.2');
    assert.notEqual(parseZcodeCliVersion('0.16.2\n'), REQUIRED_ZCODE_VERSION);
    assert.equal(parseZcodeCliVersion('1.0.0\n'), '1.0.0');
    assert.equal(parseZcodeCliVersion('not a version\n'), undefined);
  });
});

describe('ZCode ACP live create (real 0.16.3, no prompt)', { skip: !isZcodeLiveCreateOptIn() }, () => {
  it('creates and reloads a session in an isolated home without sending a prompt', async () => {
    const bin = resolveZcodeLiveBin();
    assert.ok(bin, 'CAT_CAFE_ZCODE_LIVE=1 requires CAT_CAFE_ZCODE_BIN or a bundled ZCode.app 0.16.3 binary');
    const version = readZcodeCliVersion(bin);
    assert.equal(
      version,
      REQUIRED_ZCODE_VERSION,
      `refusing to treat ${bin} version ${version ?? '<unknown>'} as 0.16.3 protocol evidence`,
    );
    const dir = mkdtempSync(join(tmpdir(), 'zcode-live-create-'));
    const isolatedHome = join(dir, 'isolated-home');
    const liveEnv = {
      ZCODE_BIN: bin,
      CAT_CAFE_ZCODE_HOME: isolatedHome,
      ZCODE_MODEL: 'GLM-5.2',
      ANTHROPIC_API_KEY: 'dummy-zcode-live-create-not-a-secret',
    };
    const acp = startAdapter(dir, liveEnv);
    try {
      const init = await acp.request('initialize', { protocolVersion: 1 }, 20_000);
      assert.equal(init.error, undefined, JSON.stringify(init.error));
      const created = await acp.request('session/new', { cwd: dir, mcpServers: [] }, 45_000);
      assert.equal(created.error, undefined, JSON.stringify(created.error));
      const sessionId = created.result.sessionId;
      assert.ok(sessionId, 'clean-home session/create with ZCODE_MODEL env must succeed without a native model field');
      const loaded = await acp.request('session/load', { sessionId, cwd: dir, mcpServers: [] }, 45_000);
      assert.equal(loaded.error, undefined, JSON.stringify(loaded.error));
      assert.equal(loaded.result.sessionId, sessionId);
    } finally {
      acp.child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        acp.child.once('exit', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
