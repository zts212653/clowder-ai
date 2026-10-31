/**
 * MCP Perspective Tools Tests
 * Covers cat_cafe_run_perspective URL encoding and trace rendering.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Perspective Tools', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleRunPerspective encodes plan id and actor cat id into URL', async () => {
    const { handleRunPerspective } = await import('../dist/tools/perspective-tools.js');

    /** @type {string | URL | undefined} */
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          planId: 'F209/f209-phase-d-orientation',
          runId: 'run-1',
          actorCatId: 'codex',
          startedAt: '2026-05-24T00:00:00.000Z',
          effectiveInputs: {},
          steps: [],
          candidateAnchors: [],
          openedAnchors: [],
          warnings: [],
        }),
      };
    };

    const result = await handleRunPerspective({
      planId: 'F209/f209-phase-d-orientation',
      actorCatId: 'codex',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl, 'expected fetch to be called');
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/perspectives/F209/f209-phase-d-orientation/run');
    assert.equal(parsed.searchParams.get('actorCatId'), 'codex');
  });

  test('handleRunPerspective renders run trace, anchors, opened anchors, and degraded metadata', async () => {
    const { handleRunPerspective } = await import('../dist/tools/perspective-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        planId: 'F209/f209-phase-d-orientation',
        runId: 'run-1',
        actorCatId: 'codex',
        startedAt: '2026-05-24T00:00:00.000Z',
        effectiveInputs: {},
        steps: [
          {
            id: 'search-f209',
            type: 'search_evidence',
            status: 'ok',
            hitCount: 2,
            degraded: true,
            degradeReason: 'passage_embedding_unavailable',
            effectiveMode: 'lexical',
          },
          { id: 'open-top', type: 'open_anchor', status: 'ok', openedCount: 1 },
        ],
        candidateAnchors: [
          {
            anchor: 'docs/features/F209-evidence-recall-optimization.md',
            title: 'F209',
            sourceStepId: 'search-f209',
            rank: 1,
            drillDown: {
              tool: 'cat_cafe_read_file_slice',
              params: { path: 'docs/features/F209-evidence-recall-optimization.md', startLine: '200' },
              hint: 'open feature slice',
            },
          },
        ],
        openedAnchors: [
          {
            anchor: 'docs/features/F209-evidence-recall-optimization.md',
            status: 'route_identified',
            tool: 'cat_cafe_read_file_slice',
            content: 'open feature slice',
          },
        ],
        warnings: [{ stepId: 'open-top', code: 'open_anchor_failed', message: 'Unsupported anchor type' }],
      }),
    });

    const result = await handleRunPerspective({ planId: 'F209/f209-phase-d-orientation', actorCatId: 'codex' });
    const text = result.content[0].text;

    assert.equal(result.isError, undefined);
    assert.ok(text.includes('Perspective run: F209/f209-phase-d-orientation'));
    assert.ok(text.includes('runId: run-1'));
    assert.ok(text.includes('search-f209 [search_evidence] status=ok hits=2 degraded=true effectiveMode=lexical'));
    assert.ok(text.includes('degradeReason=passage_embedding_unavailable'));
    assert.ok(text.includes('docs/features/F209-evidence-recall-optimization.md'));
    assert.ok(text.includes('drillDown: cat_cafe_read_file_slice'));
    assert.ok(text.includes('route: docs/features/F209-evidence-recall-optimization.md status=route_identified'));
    assert.ok(text.includes('hint: open feature slice'));
    assert.ok(
      text.includes(
        'Boundary: Perspective returns route hints and anchors, not fetched evidence content or a conclusion.',
      ),
    );
    assert.ok(text.includes('warning[open-top/open_anchor_failed]: Unsupported anchor type'));
  });

  test('handleRunPerspective returns API errors as tool errors', async () => {
    const { handleRunPerspective } = await import('../dist/tools/perspective-tools.js');

    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error":"Perspective plan not found"}',
    });

    const result = await handleRunPerspective({ planId: 'F209/missing', actorCatId: 'codex' });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('Perspective run failed'));
    assert.ok(result.content[0].text.includes('404'));
  });
});
