import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '..', '..', '..', 'cat-template.json');

describe('cat-template.json — 金渐层 (opencode) validation', () => {
  let config;

  test('cat-template.json is valid JSON', () => {
    const raw = readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
    assert.ok(config);
  });

  test('roster includes opencode entry', () => {
    const roster = config.roster;
    assert.ok(roster.opencode, 'opencode should be in roster');
    assert.strictEqual(roster.opencode.family, 'golden-chinchilla');
    assert.ok(roster.opencode.roles.includes('coding'));
  });

  test('breeds includes golden-chinchilla', () => {
    const breed = config.breeds.find((b) => b.id === 'golden-chinchilla');
    assert.ok(breed, 'golden-chinchilla breed should exist');
    assert.strictEqual(breed.catId, 'opencode');
    assert.strictEqual(breed.name, '金渐层');
    assert.ok(breed.mentionPatterns.includes('@opencode'));
    assert.ok(breed.mentionPatterns.includes('@金渐层'));
  });

  test('opencode-default variant has correct provider and model', () => {
    const breed = config.breeds.find((b) => b.id === 'golden-chinchilla');
    const variant = breed.variants.find((v) => v.id === 'opencode-default');
    assert.ok(variant, 'opencode-default variant should exist');
    assert.strictEqual(variant.provider, 'opencode');
    assert.strictEqual(variant.defaultModel, 'claude-opus-4-6');
    assert.strictEqual(variant.mcpSupport, true);
  });

  test('defaultVariantId matches a variant', () => {
    const breed = config.breeds.find((b) => b.id === 'golden-chinchilla');
    const match = breed.variants.find((v) => v.id === breed.defaultVariantId);
    assert.ok(match, `defaultVariantId ${breed.defaultVariantId} should match a variant`);
  });

  test('cat-config-loader can parse the config without errors', async () => {
    const { loadCatConfig } = await import('../dist/config/cat-config-loader.js');
    // loadCatConfig reads from the repo root's cat-template.json
    const result = loadCatConfig(configPath);
    assert.ok(result.breeds.length > 0);
    const goldenChinchilla = result.breeds.find((b) => b.id === 'golden-chinchilla');
    assert.ok(goldenChinchilla, 'golden-chinchilla should be parsed');
  });
});
