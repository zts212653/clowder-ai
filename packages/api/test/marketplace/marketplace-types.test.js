// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Marketplace Types', () => {
  it('exports all marketplace type constants', async () => {
    const mod = await import('@cat-cafe/shared');
    assert.ok(mod.MARKETPLACE_ECOSYSTEMS);
    assert.ok(mod.MARKETPLACE_ARTIFACT_KINDS);
    assert.ok(mod.TRUST_LEVELS);
    assert.ok(mod.INSTALL_MODES);
  });

  it('MARKETPLACE_ECOSYSTEMS matches spec order', async () => {
    const { MARKETPLACE_ECOSYSTEMS } = await import('@cat-cafe/shared');
    assert.deepStrictEqual(MARKETPLACE_ECOSYSTEMS, ['claude', 'codex', 'openclaw', 'antigravity']);
  });

  it('TRUST_LEVELS has three tiers', async () => {
    const { TRUST_LEVELS } = await import('@cat-cafe/shared');
    assert.deepStrictEqual(TRUST_LEVELS, ['official', 'verified', 'community']);
  });

  it('INSTALL_MODES has four channels', async () => {
    const { INSTALL_MODES } = await import('@cat-cafe/shared');
    assert.deepStrictEqual(INSTALL_MODES, ['direct_mcp', 'delegated_cli', 'manual_file', 'manual_ui']);
  });

  it('MARKETPLACE_ARTIFACT_KINDS includes pack for F129', async () => {
    const { MARKETPLACE_ARTIFACT_KINDS } = await import('@cat-cafe/shared');
    assert.ok(MARKETPLACE_ARTIFACT_KINDS.includes('pack'));
    assert.ok(MARKETPLACE_ARTIFACT_KINDS.includes('mcp_server'));
  });
});
