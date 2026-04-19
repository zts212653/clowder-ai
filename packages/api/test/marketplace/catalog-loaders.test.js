import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let loadClaudeCatalog, loadCodexCatalog, loadOpenClawCatalog, loadAntigravityCatalog;

before(async () => {
  ({ loadClaudeCatalog, loadCodexCatalog, loadOpenClawCatalog, loadAntigravityCatalog } = await import(
    '../../dist/marketplace/catalog-loaders.js'
  ));
});

describe('catalog-loaders', () => {
  describe('loadClaudeCatalog', () => {
    it('returns non-empty array of valid entries', async () => {
      const entries = await loadClaudeCatalog();
      assert.ok(entries.length > 0, 'Claude catalog must not be empty');
      for (const e of entries) {
        assert.ok(e.id, 'entry must have id');
        assert.ok(e.name, 'entry must have name');
        assert.ok(e.description, 'entry must have description');
        assert.ok(['official', 'verified', 'community'].includes(e.trustLevel));
        assert.ok(e.publisher, 'entry must have publisher');
      }
    });

    it('includes well-known MCP servers', async () => {
      const entries = await loadClaudeCatalog();
      const ids = entries.map((e) => e.id);
      assert.ok(
        ids.some((id) => id.includes('filesystem')),
        'should include filesystem server',
      );
      assert.ok(
        ids.some((id) => id.includes('fetch')),
        'should include fetch server',
      );
    });

    it('entries have valid transport or command', async () => {
      const entries = await loadClaudeCatalog();
      for (const e of entries) {
        const hasCommand = e.command != null;
        const hasUrl = e.url != null;
        assert.ok(hasCommand || hasUrl, `entry ${e.id} must have command or url`);
      }
    });
  });

  describe('loadCodexCatalog', () => {
    it('returns non-empty array of valid entries', async () => {
      const entries = await loadCodexCatalog();
      assert.ok(entries.length > 0, 'Codex catalog must not be empty');
      for (const e of entries) {
        assert.ok(e.id, 'entry must have id');
        assert.ok(e.name, 'entry must have name');
        assert.ok(['official', 'verified', 'community'].includes(e.trustLevel));
      }
    });
  });

  describe('loadOpenClawCatalog', () => {
    it('returns non-empty array of valid entries', async () => {
      const entries = await loadOpenClawCatalog();
      assert.ok(entries.length > 0, 'OpenClaw catalog must not be empty');
      for (const e of entries) {
        assert.ok(e.id, 'entry must have id');
        assert.ok(e.name, 'entry must have name');
        assert.ok(['mcp_server', 'skill', 'bundle'].includes(e.clawType));
      }
    });
  });

  describe('loadAntigravityCatalog', () => {
    it('returns non-empty array of valid entries', async () => {
      const entries = await loadAntigravityCatalog();
      assert.ok(entries.length > 0, 'Antigravity catalog must not be empty');
      for (const e of entries) {
        assert.ok(e.id, 'entry must have id');
        assert.ok(e.name, 'entry must have name');
      }
    });
  });

  describe('cross-ecosystem search scenario', () => {
    it('figma appears in at least one catalog', async () => {
      const [claude, codex, openclaw, antigravity] = await Promise.all([
        loadClaudeCatalog(),
        loadCodexCatalog(),
        loadOpenClawCatalog(),
        loadAntigravityCatalog(),
      ]);
      const all = [...claude, ...codex, ...openclaw, ...antigravity];
      const figmaHits = all.filter(
        (e) =>
          e.name.toLowerCase().includes('figma') ||
          e.description.toLowerCase().includes('figma') ||
          e.id.toLowerCase().includes('figma'),
      );
      assert.ok(figmaHits.length > 0, 'searching "figma" should return at least one result across all catalogs');
    });

    it('filesystem appears in multiple ecosystems', async () => {
      const [claude, codex, openclaw] = await Promise.all([
        loadClaudeCatalog(),
        loadCodexCatalog(),
        loadOpenClawCatalog(),
      ]);
      const ecosystemsWithFs = [
        claude.some((e) => e.id.includes('filesystem') || e.name.toLowerCase().includes('filesystem')),
        codex.some((e) => e.id.includes('filesystem') || e.name.toLowerCase().includes('filesystem')),
        openclaw.some((e) => e.id.includes('filesystem') || e.name.toLowerCase().includes('filesystem')),
      ].filter(Boolean);
      assert.ok(ecosystemsWithFs.length >= 2, 'filesystem server should appear in at least 2 ecosystems');
    });
  });
});
