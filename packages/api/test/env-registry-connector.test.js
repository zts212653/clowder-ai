import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENV_VARS } from '../dist/config/env-registry.js';

describe('env-registry connector vars', () => {
  it('all connector category vars must have restartRequired: true', () => {
    const connectorVars = ENV_VARS.filter((v) => v.category === 'connector');
    assert.ok(connectorVars.length > 0, 'Should have connector vars');

    const missing = connectorVars.filter((v) => v.restartRequired !== true);
    assert.equal(
      missing.length,
      0,
      `${missing.length} connector vars missing restartRequired: true: ${missing.map((v) => v.name).join(', ')}`,
    );
  });
});
