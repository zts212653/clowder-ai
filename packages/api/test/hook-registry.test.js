/**
 * F237 Phase 2: HookRegistry tests
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const FIXTURES_BASE = join(import.meta.dirname, '__fixtures__', 'hook-registry-test');

function makeHook(baseDir, dirName, id, stage, order, extras = {}) {
  const hookDir = join(baseDir, dirName);
  mkdirSync(hookDir, { recursive: true });

  const yaml = [
    `id: ${id}`,
    `name: Test ${id}`,
    `stage: ${stage}`,
    `order: ${order}`,
    `version: 1`,
    `enabled: ${extras.enabled ?? true}`,
    `template: ${id.toLowerCase()}.md`,
    extras.resolver ? `resolver: ${extras.resolver}` : '',
    `inputs: []`,
    `disableable: ${extras.disableable ?? true}`,
    `safetyTier: readonly`,
    `transparencyTier: visible-by-default`,
    `governanceTier: immutable`,
  ]
    .filter(Boolean)
    .join('\n');

  writeFileSync(join(hookDir, 'hook.yaml'), yaml, 'utf-8');
  writeFileSync(join(hookDir, `${id.toLowerCase()}.md`), `<!-- ${id} -->`, 'utf-8');
}

describe('HookRegistry', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookRegistry.js').HookRegistry} */
  let HookRegistry;

  let testDir;
  let testCounter = 0;

  beforeEach(async () => {
    testCounter++;
    testDir = join(FIXTURES_BASE, `run-${testCounter}`);
    mkdirSync(testDir, { recursive: true });
    const mod = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    HookRegistry = mod.HookRegistry;
  });

  afterEach(() => {
    if (existsSync(FIXTURES_BASE)) {
      rmSync(FIXTURES_BASE, { recursive: true, force: true });
    }
  });

  it('scans and registers hooks from directory', () => {
    makeHook(testDir, 's1-identity', 'S1', 'session-init', 100);
    makeHook(testDir, 'd1-anchor', 'D1', 'per-turn', 100);

    const registry = new HookRegistry(testDir);
    const manifests = registry.scan();

    assert.equal(manifests.length, 2);
    assert.equal(registry.size, 2);
  });

  it('returns hooks by stage in order', () => {
    makeHook(testDir, 's2-test', 'S2', 'session-init', 200);
    makeHook(testDir, 's1-test', 'S1', 'session-init', 100);
    makeHook(testDir, 'd1-test', 'D1', 'per-turn', 100);

    const registry = new HookRegistry(testDir);
    registry.scan();

    const sessionHooks = registry.getStageHooks('session-init');
    assert.equal(sessionHooks.length, 2);
    assert.equal(sessionHooks[0].manifest.id, 'S1');
    assert.equal(sessionHooks[1].manifest.id, 'S2');

    const turnHooks = registry.getStageHooks('per-turn');
    assert.equal(turnHooks.length, 1);
    assert.equal(turnHooks[0].manifest.id, 'D1');
  });

  it('getHook returns single hook by ID', () => {
    makeHook(testDir, 's1-identity', 'S1', 'session-init', 100);

    const registry = new HookRegistry(testDir);
    registry.scan();

    const hook = registry.getHook('S1');
    assert.ok(hook);
    assert.equal(hook.manifest.id, 'S1');
    assert.equal(hook.manifest.stage, 'session-init');

    assert.equal(registry.getHook('NONEXISTENT'), undefined);
  });

  it('isEnabled reflects manifest baseline', () => {
    makeHook(testDir, 's1-test', 'S1', 'session-init', 100, { enabled: true });
    makeHook(testDir, 's2-test', 'S2', 'session-init', 200, { enabled: false });

    const registry = new HookRegistry(testDir);
    registry.scan();

    assert.equal(registry.isEnabled('S1'), true);
    assert.equal(registry.isEnabled('S2'), false);
    assert.equal(registry.isEnabled('NONEXISTENT'), false);
  });

  it('skips directories without hook.yaml', () => {
    mkdirSync(join(testDir, 'not-a-hook'), { recursive: true });
    writeFileSync(join(testDir, 'not-a-hook', 'readme.md'), 'nope', 'utf-8');
    makeHook(testDir, 's1-test', 'S1', 'session-init', 100);

    const registry = new HookRegistry(testDir);
    registry.scan();

    assert.equal(registry.size, 1);
  });

  it('skips hooks with missing template file', () => {
    const hookDir = join(testDir, 's1-test');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(
      join(hookDir, 'hook.yaml'),
      `
id: S1
name: Test
stage: session-init
order: 100
version: 1
enabled: true
template: nonexistent.md
inputs: []
disableable: true
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
`,
      'utf-8',
    );

    const registry = new HookRegistry(testDir);
    registry.scan();

    assert.equal(registry.size, 0);
  });

  it('rejects duplicate order within same stage', () => {
    makeHook(testDir, 's1-first', 'S1', 'session-init', 100);
    makeHook(testDir, 's2-second', 'S2', 'session-init', 100);

    const registry = new HookRegistry(testDir);
    registry.scan();

    assert.equal(registry.size, 1);
  });

  it('returns empty for nonexistent directory', () => {
    const registry = new HookRegistry('/nonexistent/path');
    const manifests = registry.scan();

    assert.deepEqual(manifests, []);
    assert.equal(registry.size, 0);
  });
});
