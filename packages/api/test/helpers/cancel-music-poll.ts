import assert from 'node:assert/strict';
import type { NativePluginActions } from '../../src/domains/plugin/declared/native-plugin-actions.js';

/** Queue a real installed-package poll at the native dispatch boundary, then cancel its MCP request. */
export async function cancelMusicPoll(
  actions: NativePluginActions,
  poll: () => Promise<Response>,
  cancel: () => Promise<Response>,
): Promise<void> {
  const original = actions.call;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const queued = new Promise<void>((resolve) => {
    release = resolve;
  });
  actions.call = async function (...args) {
    assert.equal(args[1], 'music.output');
    entered();
    await queued;
    return original.apply(this, args);
  };
  const response = poll();
  try {
    await ready;
    assert.equal((await cancel()).status, 202);
    const cancelled = await response;
    assert.equal(cancelled.status, 200);
    const body = await cancelled.json();
    assert.equal(body.result.isError, true, JSON.stringify(body));
  } finally {
    actions.call = original;
    release();
    await response;
  }
}
