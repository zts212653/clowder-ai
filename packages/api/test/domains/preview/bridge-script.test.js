import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRIDGE_SCRIPT } from '../../../dist/domains/preview/bridge-script.js';

describe('bridge-script', () => {
  it('exports a non-empty script string', () => {
    assert.ok(typeof BRIDGE_SCRIPT === 'string');
    assert.ok(BRIDGE_SCRIPT.length > 100);
  });

  it('contains console patching code', () => {
    assert.ok(BRIDGE_SCRIPT.includes('console'));
    assert.ok(BRIDGE_SCRIPT.includes('postMessage'));
    assert.ok(BRIDGE_SCRIPT.includes("type: 'console'"));
  });

  it('contains screenshot handler', () => {
    assert.ok(BRIDGE_SCRIPT.includes('screenshot-request'));
    assert.ok(BRIDGE_SCRIPT.includes('screenshot-result'));
    assert.ok(BRIDGE_SCRIPT.includes('foreignObject'));
  });

  it('includes double-injection guard', () => {
    assert.ok(BRIDGE_SCRIPT.includes('__catCafeBridge'));
  });

  it('is wrapped in a script tag', () => {
    assert.ok(BRIDGE_SCRIPT.includes('<script'));
    assert.ok(BRIDGE_SCRIPT.includes('</script>'));
  });
});
