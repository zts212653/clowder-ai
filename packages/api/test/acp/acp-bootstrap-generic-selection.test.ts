import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { WindowsAcpBootstrapError } from '../../src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-windows-error.ts';
import { ensureWindowsAcpBootstrapRoot } from '../../src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-windows-roots.ts';
import { parseAgentClientProfiles } from '../../src/domains/cats/services/agents/session-contract/plugin-agent-provider.ts';

test('an unaudited client can discover a candidate only under the full strict verifier', () => {
  const primary = resolve('missing-temp');
  const candidate = resolve('trusted-volume');
  const calls: string[] = [];
  const result = ensureWindowsAcpBootstrapRoot(
    primary,
    'client',
    (root, cwd, options) => {
      calls.push(root);
      assert.equal(options?.allowVolumeRootDelete, undefined);
      assert.equal(cwd, join(root, 'client'));
      if (root === primary) throw new WindowsAcpBootstrapError('PARENT_OWNER', 'untrusted ancestor');
    },
    undefined,
    true,
    { volumeRoots: () => [candidate] },
  );
  assert.equal(result, candidate);
  assert.deepEqual(calls, [primary, candidate]);
});

test('strict discovery never upgrades permissions and an explicit root never relocates', () => {
  let calls = 0;
  const ensure = (_root: string, _cwd: string, options?: { allowVolumeRootDelete?: boolean }) => {
    calls++;
    assert.notEqual(options?.allowVolumeRootDelete, true);
    throw new WindowsAcpBootstrapError('PARENT_REPLACEMENT', 'unsafe ancestor');
  };
  assert.throws(
    () =>
      ensureWindowsAcpBootstrapRoot(resolve('temp'), 'client', ensure, undefined, true, {
        volumeRoots: () => [resolve('data')],
      }),
    /No trusted/,
  );
  assert.equal(calls, 2);
  calls = 0;
  assert.throws(
    () =>
      ensureWindowsAcpBootstrapRoot(resolve('explicit'), 'client', ensure, undefined, false, {
        volumeRoots: () => {
          assert.fail('explicit root must not discover other volumes');
        },
      }),
    /unsafe ancestor/,
  );
  assert.equal(calls, 1);
});

test('owner client configuration accepts an absolute bootstrap root and rejects invalid roots and bypass flags', () => {
  const profile = {
    id: 'custom',
    name: 'Custom ACP',
    command: 'codeagent',
    startupArgs: ['--acp'],
    bootstrapRoot: resolve('external-bootstrap'),
  };
  const context = { packageRoot: resolve('plugin-package') };
  const result = parseAgentClientProfiles(JSON.stringify([profile]), context);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.profiles[0]?.acp.bootstrapRoot, profile.bootstrapRoot);
  for (const bootstrapRoot of ['', '../relative', 'contains\0nul']) {
    assert.equal(parseAgentClientProfiles(JSON.stringify([{ ...profile, bootstrapRoot }]), context).ok, false);
  }
  assert.equal(
    parseAgentClientProfiles(JSON.stringify([{ ...profile, allowVolumeRootDelete: true }]), context).ok,
    false,
  );
});
