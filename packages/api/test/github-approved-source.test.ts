import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL, approvedScope } from '../src/scripts/github-approved-source/approved-scope.js';

test('direct approval produces only the exact three-repository source scope', () => {
  const scope = approvedScope(APPROVAL.sourceRef, 'evidence:boot42:no-github-writers');
  assert.equal(scope.ownerUserId, 'default-user');
  assert.deepEqual(scope.repositories, APPROVAL.repositories);
  assert.deepEqual(scope.excludedTaskIds, [APPROVAL.taskId]);
  assert.equal(scope.sourceRef, APPROVAL.sourceRef);
  assert.equal(scope.keyPrefix, 'cat-cafe:');
  assert.throws(() => approvedScope(APPROVAL.cardRef, 'evidence:absence'), /Direct human/);
  assert.throws(() => approvedScope(APPROVAL.sourceRef, ''), /writer/);
});
