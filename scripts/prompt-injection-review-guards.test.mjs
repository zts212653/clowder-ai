import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import YAML from 'yaml';

describe('prompt-injection review guard scripts', () => {
  it('verify-template-extraction discloses exact byte-identity coverage', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-template-extraction.mjs'], {
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Byte-identical compatibility coverage:\s*4 templates/i);
    assert.match(result.stdout, /Additional extracted templates are not byte-compared/i);
  });

  it('check-manifest-drift enforces loader local overlay and manifest flags in both directions', () => {
    const source = readFileSync('scripts/check-manifest-drift.mjs', 'utf-8');
    assert.match(
      source,
      /extractTemplateFileInfo|TEMPLATE_LOADER_PATH/,
      'drift check should inspect loader template local registry',
    );
    assert.match(source, /allowLocalOverride/, 'drift check should compare manifest allowLocalOverride');
    assert.match(source, /LOCAL-OVERRIDE-DRIFT/, 'drift check should report local override drift explicitly');
  });

  it('native L0 compiler routes S6 through workflow trigger template overlays', () => {
    const source = readFileSync('scripts/compile-system-prompt-l0.mjs', 'utf-8');
    assert.doesNotMatch(
      source,
      /const\s+WORKFLOW_TRIGGERS_INLINE\s*=/,
      'native L0 compiler must not keep an inline S6 workflow trigger copy',
    );
    assert.match(
      source,
      /workflow-triggers\.local\.yaml/,
      'native L0 compiler must consider the same local S6 overlay file as the runtime builder',
    );
    assert.match(source, /YAML\.parse/, 'native L0 compiler must load S6 workflow trigger YAML');
  });

  it('B1 manifest points at the runtime SessionBootstrap source, not an unused template', () => {
    const manifest = YAML.parse(readFileSync('assets/prompt-injection-manifest.yaml', 'utf-8'));
    const b1 = manifest.segments.find((segment) => segment.id === 'B1');
    assert.ok(b1, 'manifest must contain B1');
    assert.equal(b1.source, 'packages/api/src/domains/cats/services/session/SessionBootstrap.ts');
    assert.equal(b1.sourceType, 'typescript');
    assert.equal(b1.allowLocalOverride, false);

    const loaderSource = readFileSync(
      'packages/api/src/domains/cats/services/context/prompt-template-loader.ts',
      'utf-8',
    );
    assert.doesNotMatch(loaderSource, /\n\s*B1:\s*\{/, 'B1 must not be exposed as a template-backed segment');
  });

  it('S6 overlay mutations invalidate the native L0 cache', () => {
    const source = readFileSync('packages/api/src/routes/prompt-injection.ts', 'utf-8');
    assert.match(source, /clearL0Cache/, 'overlay write route must import native L0 cache invalidation');
    assert.match(
      source,
      /function\s+invalidateNativeL0CacheForSegment\s*\(\s*segmentId:\s*string\s*\)/,
      'cache invalidation should be centralized by segment id',
    );
    assert.match(
      source,
      /segmentId\s*===\s*['"]S6['"][\s\S]*?clearL0Cache\(\)/,
      'S6 is the workflow-trigger overlay consumed by native L0 and must clear all cached compiled prompts',
    );
    const invalidationCalls = source.match(/invalidateNativeL0CacheForSegment\(id\)/g) ?? [];
    assert.ok(
      invalidationCalls.length >= 3,
      'S6 cache invalidation must run after save, delete, and restore-backup mutations',
    );
  });

  it('compiled preview reads the effective C1 template including local overrides', () => {
    const source = readFileSync('packages/api/src/routes/prompt-injection-preview.ts', 'utf-8');
    assert.match(
      source,
      /const\s+tpl\s*=\s*\(\s*id:\s*string,\s*useOverride\s*=\s*false\s*\)/,
      'compiled preview helper should support choosing effective template content',
    );
    assert.match(
      source,
      /getTemplateRawContent\(id,\s*useOverride\)/,
      'compiled preview helper should pass the override flag through to the template loader',
    );
    assert.match(
      source,
      /tpl\(['"]C1['"],\s*true\)/,
      'C1 preview must show c1-mcp-callback.local.md when an override exists',
    );
  });

  it('compiled preview surfaces native L0 compile failures instead of falling back', () => {
    const source = readFileSync('packages/api/src/routes/prompt-injection-preview.ts', 'utf-8');
    assert.doesNotMatch(
      source,
      /Fallback to S-segment view if L0 compilation fails/,
      'native-L0 preview must not claim success with the non-native S-segment fallback',
    );
    assert.match(
      source,
      /nativeL0CompileError/,
      'native-L0 preview errors should expose the compiler failure explicitly',
    );
  });
});
