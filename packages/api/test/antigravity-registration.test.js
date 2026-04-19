import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Antigravity provider registration', () => {
  test('cat-config-loader accepts antigravity provider', async () => {
    const { loadCatConfig } = await import('../dist/config/cat-config-loader.js');
    const config = loadCatConfig();
    const bengal = config.breeds.find((b) => b.id === 'bengal');
    assert.ok(bengal, 'bengal breed should exist in config');
    assert.ok(bengal.variants.length > 0, 'bengal should have variants');
    assert.equal(bengal.variants[0].clientId, 'antigravity');
  });

  test('AntigravityAgentService is importable', async () => {
    const mod = await import('../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js');
    assert.ok(mod.AntigravityAgentService, 'should export AntigravityAgentService');
  });

  test('AntigravityBridge is importable', async () => {
    const mod = await import('../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js');
    assert.ok(mod.AntigravityBridge, 'should export AntigravityBridge');
  });

  test('antigravity-event-transformer is importable', async () => {
    const mod = await import(
      '../dist/domains/cats/services/agents/providers/antigravity/antigravity-event-transformer.js'
    );
    assert.ok(mod.transformTrajectorySteps, 'should export transformTrajectorySteps');
  });
});
