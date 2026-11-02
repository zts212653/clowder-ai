import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCodexManagedLink,
  prepareCodexManagedLayout,
  validateCodexManagedLayout,
} from '../src/config/codex-managed-layout.js';
import {
  fileProjectionForName,
  linkTypeForProjection,
} from '../src/config/credential-projection-policy.js';

test('credential projection uses junctions only for Windows directories', () => {
  assert.equal(linkTypeForProjection('directory', 'win32'), 'junction');
  assert.equal(linkTypeForProjection('directory', 'linux'), 'dir');
  assert.equal(linkTypeForProjection('file', 'win32'), undefined);
  assert.equal(linkTypeForProjection('file', 'linux'), undefined);
});

test('managed layout files use hardlinks on Windows, symlinks elsewhere', () => {
  assert.equal(fileProjectionForName('config.toml', 'win32'), 'hardlink');
  assert.equal(fileProjectionForName('AGENTS.md', 'win32'), 'hardlink');
  assert.equal(fileProjectionForName('hooks.json', 'win32'), 'hardlink');
  assert.equal(fileProjectionForName('config.toml', 'linux'), 'symlink');
  assert.equal(fileProjectionForName('AGENTS.md', 'linux'), 'symlink');
});

test('directory projection forwards the junction type to the linker', () => {
  const calls: Array<[string, string, string | undefined]> = [];
  createCodexManagedLink(
    '/canonical/state/sessions',
    '/private/cred/sessions',
    (target, link, type) => {
      calls.push([target, link, type]);
    },
    'win32',
    'directory',
  );
  assert.deepEqual(calls, [
    ['/canonical/state/sessions', '/private/cred/sessions', 'junction'],
  ]);
});

test('managed layout Windows EPERM becomes an actionable diagnostic', () => {
  const denied = Object.assign(new Error('symlink denied'), { code: 'EPERM' });
  let failure: (Error & { code?: string; cause?: unknown }) | undefined;
  try {
    createCodexManagedLink(
      '/canonical/state/sessions',
      '/private/cred/sessions',
      () => {
        throw denied;
      },
      'win32',
    );
  } catch (error) {
    failure = error as Error & { code?: string; cause?: unknown };
  }

  assert.ok(failure, 'the EPERM must be converted, not swallowed');
  assert.equal(failure.code, 'codex_managed_layout_symlink_unavailable');
  assert.match(failure.message, /Developer Mode|symlink privilege/);
  assert.equal(failure.cause, denied);
});

test('managed layout Windows EACCES gets the same diagnostic', () => {
  const denied = Object.assign(new Error('symlink denied'), { code: 'EACCES' });
  assert.throws(
    () =>
      createCodexManagedLink(
        '/canonical/state/sessions',
        '/private/cred/sessions',
        () => {
          throw denied;
        },
        'win32',
      ),
    (error: NodeJS.ErrnoException & { cause?: unknown }) =>
      error.code === 'codex_managed_layout_symlink_unavailable' && error.cause === denied,
  );
});

test('managed layout non-Windows link failures keep their original error', () => {
  const denied = Object.assign(new Error('symlink denied'), { code: 'EPERM' });
  assert.throws(
    () =>
      createCodexManagedLink(
        '/canonical/state/sessions',
        '/private/cred/sessions',
        () => {
          throw denied;
        },
        'linux',
      ),
    (error: NodeJS.ErrnoException) => error === denied,
  );
});

test('managed layout link helper forwards target and link', () => {
  const calls: string[][] = [];
  createCodexManagedLink(
    '/canonical/state/sessions',
    '/private/cred/sessions',
    (target, link) => {
      calls.push([target, link]);
    },
    'win32',
  );
  assert.deepEqual(calls, [['/canonical/state/sessions', '/private/cred/sessions']]);
});

test(
  'Windows non-elevated managed layout uses junction directories and hardlinked files',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-managed-layout-'));
    const credentialHome = join(root, 'cred');
    const stateRoot = join(root, 'state');
    const layout = {
      kind: 'managed' as const,
      layoutVersion: 1,
      prepared: false,
      credentialHome,
      stateRoot,
      sqliteHome: credentialHome,
    };
    try {
      const prepared = prepareCodexManagedLayout(layout);
      validateCodexManagedLayout(prepared);

      for (const name of ['sessions', 'skills']) {
        const link = join(credentialHome, name);
        assert.equal(lstatSync(link).isSymbolicLink(), true);
        assert.equal(readlinkSync(link), join(stateRoot, name));
      }

      for (const name of ['config.toml', 'AGENTS.md', 'hooks.json']) {
        const target = join(stateRoot, name);
        const link = join(credentialHome, name);
        assert.equal(lstatSync(link).isSymbolicLink(), false);
        assert.equal(statSync(link).ino, statSync(target).ino);
      }

      writeFileSync(join(stateRoot, 'AGENTS.md'), 'shared instructions\n');
      assert.equal(readFileSync(join(credentialHome, 'AGENTS.md'), 'utf8'), 'shared instructions\n');
      writeFileSync(join(stateRoot, 'config.toml'), 'model = "shared"\n');
      assert.equal(readFileSync(join(credentialHome, 'config.toml'), 'utf8'), 'model = "shared"\n');
      validateCodexManagedLayout(prepared);

      const again = prepareCodexManagedLayout({ ...prepared, prepared: false });
      validateCodexManagedLayout(again);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
