import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInstallPreview } from '../dist/config/capabilities/capability-install.js';

describe('F146-D: buildInstallPreview ecosystem pass-through', () => {
  it('preserves ecosystem in generated entry', () => {
    const result = buildInstallPreview({
      id: 'test-mcp',
      command: 'npx',
      args: ['-y', '@test/server'],
      ecosystem: 'claude',
    });
    assert.equal(result.entry.ecosystem, 'claude');
  });

  it('omits ecosystem when not provided', () => {
    const result = buildInstallPreview({
      id: 'test-mcp',
      command: 'npx',
    });
    assert.equal(result.entry.ecosystem, undefined);
  });

  it('supports all four ecosystems', () => {
    for (const eco of ['claude', 'codex', 'openclaw', 'antigravity']) {
      const result = buildInstallPreview({
        id: `test-${eco}`,
        command: 'npx',
        ecosystem: eco,
      });
      assert.equal(result.entry.ecosystem, eco);
    }
  });
});
