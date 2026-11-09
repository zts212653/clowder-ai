import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readKimiModelMetadata } from '../dist/utils/kimi-model-metadata.js';

test('Kimi keeps alias metadata separate and never guesses an undeclared default tier', () => {
  const root = mkdtempSync(join(tmpdir(), 'kimi-metadata-'));
  const path = join(root, 'config.toml');
  try {
    writeFileSync(
      path,
      `default_model = "native/new-model"
[thinking]
enabled = true
[models."native/old-model"]
model = "k3"
support_efforts = [ "low", "high", "max" ]
default_effort = "max"
[models."native/new-model"]
model = "k3.1-pro"
support_efforts = [ "low", "medium", "high" ]
[models."gemini/no-tiers"]
model = "gemini-3.1-pro"
`,
    );
    const metadata = readKimiModelMetadata(path);
    assert.equal(metadata.models[0].defaultEffort, 'max');
    assert.equal(metadata.models[1].defaultEffort, undefined);
    assert.equal(metadata.models[2].efforts, undefined);
    assert.equal(metadata.models[2].defaultEffort, undefined);
    assert.equal(metadata.thinkingEnabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi keeps disabled thinking distinct from tier values and strips credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'kimi-metadata-'));
  const path = join(root, 'config.toml');
  try {
    writeFileSync(
      path,
      `default_model = "native/k3.1"
[thinking]
enabled = false
effort = "high"
[models."native/k3.1"]
support_efforts = ["low", "high", "max"]
[providers.native]
api_key = "private-sentinel"
`,
    );
    const metadata = readKimiModelMetadata(path);
    assert.equal(metadata.thinkingEnabled, false);
    assert.equal(metadata.models[0].defaultEffort, undefined);
    assert.doesNotMatch(JSON.stringify(metadata), /private-sentinel|api_key/);
    writeFileSync(path, 'models = "invalid-boundary"');
    assert.equal(readKimiModelMetadata(path), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
