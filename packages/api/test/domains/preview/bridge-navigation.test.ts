import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { BRIDGE_SCRIPT } from '../../../src/domains/preview/bridge-script.js';

function bridge() {
  const calls: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const parent = { postMessage() {} };
  const window = {
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    history: { back: () => calls.push('back'), forward: () => calls.push('forward') },
    location: { reload: () => calls.push('reload') },
  };
  runInNewContext(BRIDGE_SCRIPT.replace(/^\s*<script[^>]*>|<\/script>\s*$/g, ''), {
    window,
    parent,
    console: { log() {}, info() {}, warn() {}, error() {} },
  });
  return { calls, parent, message: listeners.get('message')! };
}

describe('preview bridge navigation owner', () => {
  it('executes back, forward and reload inside the preview page', () => {
    const owner = bridge();
    for (const op of ['back', 'forward', 'reload']) {
      owner.message({ source: owner.parent, data: { source: 'cat-cafe-preview', type: 'navigate', op } });
    }
    assert.deepEqual(owner.calls, ['back', 'forward', 'reload']);
  });

  it('uses the same parent and source check as screenshot requests', () => {
    const owner = bridge();
    owner.message({ source: {}, data: { source: 'cat-cafe-preview', type: 'navigate', op: 'reload' } });
    owner.message({ source: owner.parent, data: { source: 'another-frame', type: 'navigate', op: 'back' } });
    owner.message({ source: owner.parent, data: null });
    assert.deepEqual(owner.calls, []);
  });

  it('ignores unknown operations and message kinds', () => {
    const owner = bridge();
    for (const data of [
      { type: 'navigate', op: 'replace', url: 'https://other.test/' },
      { type: 'navigate' },
      { type: 'other', op: 'reload' },
    ])
      owner.message({ source: owner.parent, data: { source: 'cat-cafe-preview', ...data } });
    assert.deepEqual(owner.calls, []);
  });
});
