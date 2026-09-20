import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('F257 harness-ledger production publish wiring', () => {
  it('constructs the generator and advertises scheduled publish support from the same bootstrap', () => {
    assert.match(
      indexSource,
      /publish-verdict\/harness-ledger\/harness-ledger-generator-adapter\.js/,
      'production bootstrap must import the Harness Ledger generator from its owned cell',
    );
    assert.match(
      indexSource,
      /verdictGenerators\['eval:harness-ledger'\]\s*=\s*createHarnessLedgerGeneratorAdapter\(\)/,
      'publish-verdict must route eval:harness-ledger to its generator',
    );
    assert.match(
      indexSource,
      /wiredPublishDomains\.add\('eval:harness-ledger'\)/,
      'scheduled invocations must receive publish instructions when the generator is wired',
    );
  });
});
