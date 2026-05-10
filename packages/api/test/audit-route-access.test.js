// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canAccessThread } from '../dist/domains/guides/guide-state-access.js';

describe('audit route access control (canAccessThread)', () => {
  it('allows owner to access their thread', () => {
    const thread = { id: 'thread-123', createdBy: 'user-alice' };
    assert.ok(canAccessThread(thread, 'user-alice'));
  });

  it('allows any user to access the shared default thread', () => {
    const thread = { id: 'default', createdBy: 'system' };
    assert.ok(canAccessThread(thread, 'user-bob'));
  });

  it('forbids access to non-default system-owned thread', () => {
    const thread = { id: 'thread-system-private', createdBy: 'system' };
    assert.equal(canAccessThread(thread, 'user-bob'), false);
  });

  it('forbids access to another user thread', () => {
    const thread = { id: 'thread-456', createdBy: 'user-alice' };
    assert.equal(canAccessThread(thread, 'user-eve'), false);
  });

  it('returns false for null thread', () => {
    assert.equal(canAccessThread(null, 'user-alice'), false);
  });
});
