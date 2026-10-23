import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexManagedLink } from '../src/config/codex-managed-layout.js';

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
