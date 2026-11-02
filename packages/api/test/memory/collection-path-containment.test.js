import assert from 'node:assert/strict';
import { join } from 'node:path';
import { it } from 'node:test';
import { computeChildExcludes } from '../../dist/domains/memory/factory.js';

it('computes native child excludes without siblings, parents or cross-drive aliases', () => {
  const root = process.platform === 'win32' ? 'C:\\Project' : '/workspace/Project';
  assert.deepEqual(computeChildExcludes(root, [{ root: join(root, 'notes') }]), ['notes/**']);
  assert.deepEqual(computeChildExcludes(root, [{ root: join(root, '..drafts') }]), ['..drafts/**']);
  assert.deepEqual(computeChildExcludes(root, [{ root }, { root: `${root}-sibling` }, { root: join(root, '..') }]), []);
  if (process.platform === 'win32') {
    assert.deepEqual(computeChildExcludes(root, [{ root: 'c:\\project\\notes' }]), ['notes/**']);
    assert.deepEqual(computeChildExcludes(root, [{ root: 'Z:\\Project\\notes' }]), []);
  } else {
    assert.deepEqual(computeChildExcludes(root, [{ root: '/workspace/project/notes' }]), []);
  }
});
