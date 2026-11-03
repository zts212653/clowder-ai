import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  _clearRuntimeOverrides,
  deleteRuntimeOverride,
  getRuntimeOverride,
  setRuntimeOverride,
} from '../dist/config/session-strategy-overrides.js';

describe('member session strategy owner compare-and-set', () => {
  afterEach(_clearRuntimeOverrides);

  it('accepts only one of two concurrent editors holding the same revision', async () => {
    const before = await setRuntimeOverride('member-cas', { strategy: 'compress' });
    const writes = await Promise.allSettled([
      setRuntimeOverride('member-cas', { strategy: 'handoff' }, before.revision),
      setRuntimeOverride('member-cas', { strategy: 'hybrid' }, before.revision),
    ]);
    assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(writes.filter((result) => result.status === 'rejected').length, 1);
  });

  it('does not delete a strategy saved after an editor read it', async () => {
    const first = await setRuntimeOverride('member-cas', { strategy: 'compress' });
    await setRuntimeOverride('member-cas', { strategy: 'hybrid' }, first.revision);
    await assert.rejects(() => deleteRuntimeOverride('member-cas', first.revision), /revision|其他页面/);
    assert.equal(getRuntimeOverride('member-cas')?.strategy, 'hybrid');
  });

  it('rejects a stale create after another editor created an override', async () => {
    await setRuntimeOverride('member-cas', { strategy: 'compress' });
    await assert.rejects(() => setRuntimeOverride('member-cas', { strategy: 'handoff' }, 'none'), /revision|其他页面/);
    assert.equal(getRuntimeOverride('member-cas')?.strategy, 'compress');
  });
});
