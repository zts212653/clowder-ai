import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { resolveAcpBootstrapCwd } from '../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.js';
import { WindowsAcpBootstrapError } from '../../dist/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-windows-error.js';

function fixture(run) {
  const parent = mkdtempSync(join(tmpdir(), 'acp-relocation-1653-'));
  try {
    return run(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
const windows = { skip: process.platform !== 'win32' };

test('ancestor owner failure may relocate to an independently verified ProgramData candidate', windows, () =>
  fixture((parent) => {
    const primary = join(parent, 'primary');
    const fallback = join(parent, 'fallback');
    const calls = [];
    const ensure = (root, cwd) => {
      calls.push(root);
      if (root === primary)
        throw new WindowsAcpBootstrapError('PARENT_OWNER', 'ACP bootstrap parent has an untrusted owner');
      mkdirSync(cwd, { recursive: true });
    };
    const cwd = resolveAcpBootstrapCwd(parent, 'dsh', primary, ensure, fallback, true);
    assert.equal(dirname(cwd), fallback);
    assert.deepEqual(calls, [primary, fallback]);
  }),
);

test('two rejected ancestor chains can reach a data-volume candidate for an audited startup', windows, () =>
  fixture((parent) => {
    const primary = join(parent, 'primary');
    const fallback = join(parent, 'fallback');
    const volumeRoot = join(parent, 'volume-root');
    const calls = [];
    const ensure = (root, cwd, options) => {
      calls.push(root);
      if (root === primary)
        throw new WindowsAcpBootstrapError('PARENT_REPLACEMENT', 'permits unsafe directory replacement');
      if (root === fallback)
        throw new WindowsAcpBootstrapError('PARENT_OWNER', 'ACP bootstrap parent has an untrusted owner');
      assert.equal(options.allowVolumeRootDelete, true);
      mkdirSync(cwd, { recursive: true });
    };
    const cwd = resolveAcpBootstrapCwd(parent, 'pi', primary, ensure, fallback, true, {
      allowVolumeRootDelete: true,
      volumeRoots: () => [volumeRoot],
    });
    assert.equal(dirname(cwd), volumeRoot);
    assert.deepEqual(calls, [primary, fallback, volumeRoot]);
  }),
);

for (const code of ['DIRECTORY_OWNER', 'UNSUPPORTED_ACL', 'VERIFICATION_UNAVAILABLE']) {
  test(`${code} never becomes permission to relocate or repair an existing directory`, windows, () =>
    fixture((parent) => {
      let calls = 0;
      const failure = new WindowsAcpBootstrapError(code, 'untrusted owner / permits unsafe directory replacement');
      assert.throws(
        () =>
          resolveAcpBootstrapCwd(
            parent,
            'pi',
            join(parent, 'primary'),
            () => {
              calls++;
              throw failure;
            },
            join(parent, 'fallback'),
            true,
            { allowVolumeRootDelete: true, volumeRoots: () => [] },
          ),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    }),
  );
}

test('an explicit root remains fail-closed even for an audited startup', windows, () =>
  fixture((parent) => {
    let calls = 0;
    assert.throws(
      () =>
        resolveAcpBootstrapCwd(
          parent,
          'dsh',
          join(parent, 'explicit'),
          () => {
            calls++;
            throw new WindowsAcpBootstrapError('PARENT_OWNER', 'untrusted owner');
          },
          join(parent, 'fallback'),
          false,
          { allowVolumeRootDelete: true, volumeRoots: () => [] },
        ),
      /untrusted owner/,
    );
    assert.equal(calls, 1);
  }),
);
