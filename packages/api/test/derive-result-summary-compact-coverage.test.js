/**
 * F332 find (#7138 R3): beside other find groups a coverage page may switch to compact rows. The recall candidate
 * parser must keep each row's sourcePath (including "=" for an anchor that is its own path) so the same original
 * Read still pairs with its candidate. Uses the real renderer, the real parser and the real target matcher.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

let saved;
let originalFetch;
beforeEach(() => {
  saved = { ...process.env };
  originalFetch = globalThis.fetch;
  for (const key of Object.keys(process.env)) if (key.startsWith('CAT_CAFE_')) delete process.env[key];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3102';
  process.env.CAT_CAFE_INVOCATION_ID = 'compact-coverage';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'cov-test';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  globalThis.fetch = originalFetch;
});

const text = (result) => result.content.map((block) => block.text ?? '').join('\n');
const input = { query: '线索', intent: 'coverage', limit: 20 };

/** A 20-row page that fills the docs-only budget; row 0's anchor is an ADR id with a separate docs path. */
async function nearFullPage(renderCoverageToolResponse) {
  for (let extra = 600; extra <= 1200; extra += 10) {
    const data = {
      totalHits: 20,
      bySource: { docs: { count: 20, cap: 20 } },
      matrix: Array.from({ length: 20 }, (_, i) => {
        const path = `docs/${'path/'.repeat(85)}source-${i}.md`;
        return {
          title: `Doc ${i} ${'题'.repeat(150 + (i === 0 ? extra : 0))}`,
          anchor: i === 0 ? 'ADR-019' : path,
          sourcePath: path,
          kind: 'plan',
          matchType: 'phrase',
          source: 'docs',
        };
      }),
    };
    const original = renderCoverageToolResponse(data, input, JSON.stringify(input.query));
    const length = text(original).length;
    if (length >= 23_930 && length < 24_000 && (text(original).match(/\[matchType:/g) ?? []).length === 20)
      return { data, original };
  }
  throw new Error('fixture did not reach the docs-only budget');
}

test('compact coverage rows keep the candidate sourcePath that pairs a real Read', async () => {
  const { handleSearchEvidence } = await import('@cat-cafe/mcp-server/dist/tools/evidence-tools.js');
  const { renderCoverageToolResponse } = await import('@cat-cafe/mcp-server/dist/tools/evidence-coverage-response.js');
  const { deriveResultSummary } = await import('../dist/domains/cats/services/tool-usage/derive-result-summary.js');
  const { targetMatch } = await import('../dist/domains/memory/recall-target-match.js');
  const { data, original } = await nearFullPage(renderCoverageToolResponse);
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname === '/api/evidence/search') return Response.json(data);
    if (pathname === '/api/callbacks/memory-matters')
      return Response.json({
        items: [
          {
            matterId: 'matter-1',
            title: '线索相关事情',
            description: '',
            revision: 1,
            status: 'active',
            createdAt: 1,
            updatedAt: 2,
            entryCount: 1,
            readRef: { kind: 'matter', matterId: 'matter-1', expectedRevision: 1 },
          },
        ],
      });
    throw new Error(`unexpected ${pathname}`);
  };
  const unified = await handleSearchEvidence(input);
  assert.match(text(unified), /compact rows/);

  const before = deriveResultSummary('search_evidence', original.content)._f200Candidates;
  const after = deriveResultSummary('search_evidence', unified.content)._f200Candidates;
  assert.equal(after.length, 20);
  assert.deepEqual(
    after.map(({ anchor, sourcePath }) => ({ anchor, sourcePath })),
    before.map(({ anchor, sourcePath }) => ({ anchor, sourcePath })),
  );
  // Row 0: anchor ADR-019 differs from its docs path; row 1: the path is written "=" in the compact row.
  for (const index of [0, 1]) {
    const read = { file_path: data.matrix[index].sourcePath };
    const ref = (candidate) => ({ kind: 'doc', sourcePath: candidate.sourcePath ?? '', anchor: candidate.anchor });
    assert.equal(targetMatch('Read', read, ref(before[index])), true, `row ${index} original`);
    assert.equal(targetMatch('Read', read, ref(after[index])), true, `row ${index} compact`);
  }
  assert.match(text(unified), /^ {2}anchor: ADR-019 \[matchType:phrase\] /m);
  assert.match(text(unified), /^ {2}anchor: docs\/\S+source-1\.md \[matchType:phrase\] \[.*"="/m);
});
