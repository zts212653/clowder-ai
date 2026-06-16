import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

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
});
