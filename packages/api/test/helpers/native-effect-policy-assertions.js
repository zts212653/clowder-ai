import assert from 'node:assert/strict';

// Parser qualification is separate from the A/B permission choice. An unknown
// sanctuary effect is not a proved read under either policy; known protected
// effects and independent structural boundaries still require their refusal.
export function assertGuardedOrUnproved(verdict, message) {
  if (['ordinary', 'remote_repository'].includes(verdict.target.kind)) {
    assert.notEqual(verdict.effect, 'read', message);
    return;
  }
  if (verdict.effect === 'unknown' && ['runtime_sanctuary', 'redis_sanctuary'].includes(verdict.target.kind)) {
    assert.notEqual(verdict.reasonCode, 'read_only', message);
    return;
  }
  assert.equal(verdict.decision, 'deny', message);
}
