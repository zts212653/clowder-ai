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
});
