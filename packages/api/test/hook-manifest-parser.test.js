/**
 * F237 Phase 2: Hook manifest parser tests
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const FIXTURES_DIR = join(import.meta.dirname, '__fixtures__', 'prompt-hooks-parser-test');

describe('parseHookManifest', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/hook-manifest-parser.js').parseHookManifest} */
  let parseHookManifest;

  beforeEach(async () => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const mod = await import('../dist/domains/prompt-hooks/hook-manifest-parser.js');
    parseHookManifest = mod.parseHookManifest;
  });

  afterEach(() => {
    if (existsSync(FIXTURES_DIR)) {
      rmSync(FIXTURES_DIR, { recursive: true, force: true });
    }
  });

  function writeYaml(name, content) {
    const path = join(FIXTURES_DIR, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('parses a valid hook.yaml', () => {
    const path = writeYaml(
      'valid.yaml',
      `
id: D5
name: Ping-Pong Warning
stage: per-turn
order: 500
version: 1
enabled: true
template: d5-ping-pong-warning.md
resolver: D5PingPongResolver
inputs:
  - pingPongWarning
disableable: true
safetyTier: limited-edit
transparencyTier: visible-by-default
governanceTier: human-gated
userExplanation: "test explanation"
`,
    );
    const result = parseHookManifest(path);
    assert.equal(result.ok, true);
    assert.ok(result.manifest);
    assert.equal(result.manifest.id, 'D5');
    assert.equal(result.manifest.stage, 'per-turn');
    assert.equal(result.manifest.order, 500);
    assert.equal(result.manifest.disableable, true);
    assert.deepEqual(result.manifest.inputs, ['pingPongWarning']);
    assert.equal(result.manifest.resolver, 'D5PingPongResolver');
    assert.equal(result.manifest.safetyTier, 'limited-edit');
    assert.equal(result.manifest.governanceTier, 'human-gated');
  });

  it('rejects missing required fields', () => {
    const path = writeYaml(
      'missing.yaml',
      `
id: X1
name: Test
`,
    );
    const result = parseHookManifest(path);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes('stage')));
    assert.ok(result.errors.some((e) => e.includes('order')));
  });

  it('rejects invalid stage enum', () => {
    const path = writeYaml(
      'bad-stage.yaml',
      `
id: D5
name: Test
stage: pre-session
order: 100
version: 1
enabled: true
template: t.md
inputs: []
disableable: true
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
`,
    );
    const result = parseHookManifest(path);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('stage')));
  });

  it('rejects invalid hook ID format', () => {
    const path = writeYaml(
      'bad-id.yaml',
      `
id: invalid-id
name: Test
stage: per-turn
order: 100
version: 1
enabled: true
template: t.md
inputs: []
disableable: true
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
`,
    );
    const result = parseHookManifest(path);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('pattern')));
  });

  it('rejects negative order', () => {
    const path = writeYaml(
      'neg-order.yaml',
      `
id: D5
name: Test
stage: per-turn
order: -100
version: 1
enabled: true
template: t.md
inputs: []
disableable: true
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
`,
    );
    const result = parseHookManifest(path);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('order')));
  });

  it('accepts hook without resolver', () => {
    const path = writeYaml(
      'no-resolver.yaml',
      `
id: L1
name: Parallel World
stage: session-init
order: 100
version: 1
enabled: true
template: l1.md
inputs: []
disableable: false
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
`,
    );
    const result = parseHookManifest(path);
    assert.equal(result.ok, true);
    assert.equal(result.manifest.resolver, undefined);
  });

  it('returns error for nonexistent file', () => {
    const result = parseHookManifest('/nonexistent/path.yaml');
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes('Cannot read'));
  });
});
