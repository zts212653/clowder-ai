import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const { isAllowedProviderProfilesRoot } = await import('../dist/config/provider-profiles-root.js');
const { isUnderAllowedRoot } = await import('../dist/utils/project-path.js');

const savedProjectAllowedRoots = process.env.PROJECT_ALLOWED_ROOTS;
const savedProjectAllowedRootsAppend = process.env.PROJECT_ALLOWED_ROOTS_APPEND;

afterEach(() => {
  if (savedProjectAllowedRoots === undefined) {
    delete process.env.PROJECT_ALLOWED_ROOTS;
  } else {
    process.env.PROJECT_ALLOWED_ROOTS = savedProjectAllowedRoots;
  }

  if (savedProjectAllowedRootsAppend === undefined) {
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
  } else {
    process.env.PROJECT_ALLOWED_ROOTS_APPEND = savedProjectAllowedRootsAppend;
  }
});

test('allows /workspace in the default project and provider-profile allowlists', () => {
  delete process.env.PROJECT_ALLOWED_ROOTS;
  delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;

  assert.equal(isUnderAllowedRoot('/workspace/example-repo'), true);
  assert.equal(isAllowedProviderProfilesRoot('/workspace/example-repo'), true);
});

test('provider-profile sharing honors PROJECT_ALLOWED_ROOTS replacement mode', () => {
  process.env.PROJECT_ALLOWED_ROOTS = '/opt/allowed-only';
  delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;

  assert.equal(isUnderAllowedRoot('/workspace/example-repo'), false);
  assert.equal(isAllowedProviderProfilesRoot('/workspace/example-repo'), false);
});
