import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function interfaceBody(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `missing interface ${name}`);
  const next = source.indexOf('\nexport interface ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('F263 evidence search axis contract', () => {
  it('forbids naked confidence fields on typed result surfaces', async () => {
    const interfaces = await read('src/domains/memory/interfaces.ts');
    const helpers = await read('src/routes/evidence-helpers.ts');
    const callbackRoute = await read('src/routes/callback-memory-routes.ts');
    const coverage = await read('src/domains/memory/coverage-search-types.ts');
    const recall = await read('../shared/src/recall-outcome.ts');
    const mcpTopk = await read('../mcp-server/src/tools/evidence-tools.ts');
    const mcpCoverage = await read('../mcp-server/src/tools/evidence-coverage-response.ts');
    const webCard = await read('../web/src/components/EvidenceCard.tsx');
    const webSearch = await read('../web/src/components/memory/EvidenceSearch.tsx');
    const recallFeedParser = await read('../web/src/hooks/useRecallEvents.ts');

    const scopedContracts = [
      interfaceBody(interfaces, 'EvidenceItem'),
      interfaceBody(helpers, 'EvidenceResult'),
      callbackRoute,
      interfaceBody(recall, 'RecallPreviewItem'),
      coverage,
      mcpTopk,
      mcpCoverage,
      interfaceBody(webCard, 'EvidenceResult'),
      webSearch,
      recallFeedParser,
    ];
    for (const source of scopedContracts) {
      assert.doesNotMatch(source, /^\s*(?:readonly\s+)?confidence\??\s*:/m);
    }
  });

  it('keeps coverage relation types out of the match-rank axis', async () => {
    const recall = await read('../shared/src/recall-outcome.ts');
    const mcpCoverage = await read('../mcp-server/src/tools/evidence-coverage-response.ts');
    const recallFeedParser = await read('../web/src/hooks/useRecallEvents.ts');

    assert.match(recall, /matchRank\?: RecallMatchRank;/);
    assert.match(recall, /matchType\?: RecallMatchType;/);
    assert.doesNotMatch(mcpCoverage, /\bmatchRank\b/);
    assert.match(mcpCoverage, /matchType: item\.matchType/);
    assert.match(recallFeedParser, /direct\|alias\|source-thread\|convention/);
    assert.doesNotMatch(recallFeedParser, /const legacy = lines\[i\]\.match/);
  });
});
