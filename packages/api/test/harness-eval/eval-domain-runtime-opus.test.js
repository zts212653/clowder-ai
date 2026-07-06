import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseEvalDomainRegistryFile } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const evalDomainsDir = join(repoRoot, 'docs', 'harness-feedback', 'eval-domains');
const currentOpus = {
  catId: 'opus',
  handle: '@opus',
  model: 'claude-sonnet-5',
};

function readEvalDomains() {
  return readdirSync(evalDomainsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => {
      const path = join(evalDomainsDir, entry.name);
      return {
        file: entry.name,
        domain: parseEvalDomainRegistryFile(parse(readFileSync(path, 'utf8'))),
      };
    });
}

describe('docs-backed eval domain runtime routing', () => {
  it('routes every eval domain invocation and handoff to the current opus identity', () => {
    const mismatches = [];
    for (const { file, domain } of readEvalDomains()) {
      if (domain.evalCat.catId !== currentOpus.catId) {
        mismatches.push(`${file}: evalCat.catId expected ${currentOpus.catId}, got ${domain.evalCat.catId}`);
      }
      if (domain.evalCat.handle !== currentOpus.handle) {
        mismatches.push(`${file}: evalCat.handle expected ${currentOpus.handle}, got ${domain.evalCat.handle}`);
      }
      if (domain.evalCat.model !== currentOpus.model) {
        mismatches.push(`${file}: evalCat.model expected ${currentOpus.model}, got ${domain.evalCat.model}`);
      }
      if (domain.handoffTargetResolver.ownerCatId !== currentOpus.catId) {
        mismatches.push(
          `${file}: handoffTargetResolver.ownerCatId expected ${currentOpus.catId}, got ${domain.handoffTargetResolver.ownerCatId}`,
        );
      }
    }

    assert.deepEqual(mismatches, []);
  });
});
