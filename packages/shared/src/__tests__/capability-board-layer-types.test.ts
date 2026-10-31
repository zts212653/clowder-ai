import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityBoardItem, CapabilityEntry, McpInstallRequest } from '../types/capability.js';
import type { MarketplaceEcosystem } from '../types/marketplace.js';

describe('F146-D: CapabilityBoardItem layer/ecosystem fields', () => {
  it('accepts layer field on board item', () => {
    const item: CapabilityBoardItem = {
      id: 'test-mcp',
      type: 'mcp',
      source: 'external',
      enabled: true,
      cats: {},
      layer: 'L1',
    };
    assert.equal(item.layer, 'L1');
  });

  it('accepts ecosystem field on board item', () => {
    const item: CapabilityBoardItem = {
      id: 'test-mcp',
      type: 'mcp',
      source: 'external',
      enabled: true,
      cats: {},
      ecosystem: 'claude',
    };
    assert.equal(item.ecosystem, 'claude');
  });

  it('accepts lockVersion field on board item', () => {
    const item: CapabilityBoardItem = {
      id: 'test-mcp',
      type: 'mcp',
      source: 'external',
      enabled: true,
      cats: {},
      lockVersion: {
        source: 'marketplace',
        version: '1.0.0',
        installedAt: '2026-04-19T00:00:00Z',
        installedBy: 'opus',
      },
    };
    assert.equal(item.lockVersion?.source, 'marketplace');
  });

  it('accepts all layer values', () => {
    const layers: CapabilityBoardItem['layer'][] = ['L1', 'L2', 'L3', undefined];
    assert.equal(layers.length, 4);
  });
});

describe('F146-D: CapabilityEntry ecosystem field', () => {
  it('accepts ecosystem field on config entry', () => {
    const entry: CapabilityEntry = {
      id: 'test-mcp',
      type: 'mcp',
      enabled: true,
      source: 'external',
      ecosystem: 'codex',
    };
    assert.equal(entry.ecosystem, 'codex');
  });
});

describe('F146-D: McpInstallRequest ecosystem field', () => {
  it('accepts ecosystem in install request', () => {
    const req: McpInstallRequest = {
      id: 'test-mcp',
      ecosystem: 'openclaw',
    };
    assert.equal(req.ecosystem, 'openclaw');
  });
});
