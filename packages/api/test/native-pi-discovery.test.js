import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverAdditionalRuntimes } from '../dist/routes/native-additional-runtimes.js';

test('native Pi uses the bundled bridge when Pi exists but pi-acp is absent, without probing OpenCode', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-pi-discovery-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, '.pi/agent');
  try {
    const bridge = join(root, 'pi-acp-bridge.js');
    writeFileSync(bridge, '// test-owned bundled entry');
    const calls = [];
    const resolve = (name) => {
      calls.push(name);
      return name === 'pi' ? join(root, 'pi.cmd') : null;
    };
    const found = discoverAdditionalRuntimes(root, resolve, { piBridgeEntry: bridge });
    const pi = found.find((item) => item.id === 'pi');
    assert.equal(pi.discoveryStatus, 'configured');
    assert.equal(pi.acp.command, process.execPath);
    assert.deepEqual(pi.acp.startupArgs, [bridge, '--pi-command', join(root, 'pi.cmd')]);
    assert.equal(
      found.some((item) => item.id === 'opencode'),
      false,
    );
    assert.equal(calls.includes('opencode'), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
