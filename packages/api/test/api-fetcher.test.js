import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { ApiFetcher } = await import('../dist/domains/signals/fetchers/api-fetcher.js');

function createSource(overrides = {}) {
  return {
    id: 'github-releases',
    name: 'GitHub Releases',
    url: 'https://api.github.com/repos/openai/openai-python/releases',
    tier: 1,
    category: 'official',
    enabled: true,
    fetch: {
      method: 'api',
      timeoutMs: 5000,
      headers: {
        Accept: 'application/json',
      },
    },
    schedule: {
      frequency: 'daily',
    },
    ...overrides,
  };
}

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return payload;
    },
  };
}

describe('ApiFetcher', () => {
  it('canHandle returns true only for api sources', () => {
    const fetcher = new ApiFetcher(async () => createJsonResponse([]));

    assert.equal(fetcher.canHandle(createSource()), true);
    assert.equal(fetcher.canHandle(createSource({ fetch: { method: 'rss' } })), false);
  });

  it('fetch maps GitHub-style release payload', async () => {
    const fetcher = new ApiFetcher(async () =>
      createJsonResponse([
        {
          name: 'v1.0.0',
          html_url: 'https://github.com/openai/openai-python/releases/tag/v1.0.0',
          published_at: '2026-02-18T09:00:00.000Z',
          body: 'Major release',
        },
      ]),
    );

    const result = await fetcher.fetch(createSource());

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, 'v1.0.0');
    assert.equal(result.articles[0].url, 'https://github.com/openai/openai-python/releases/tag/v1.0.0');
    assert.equal(result.metadata.source, 'github-releases');
  });

  it('fetch maps Algolia-style hits payload', async () => {
    const fetcher = new ApiFetcher(async () =>
      createJsonResponse({
        hits: [
          {
            title: 'Agentic workflows in production',
            url: 'https://example.com/agentic-workflows',
            created_at: '2026-02-18T10:00:00.000Z',
            story_text: 'Post body',
          },
        ],
      }),
    );

    const result = await fetcher.fetch(
      createSource({
        id: 'hn-algolia',
        name: 'HN Algolia',
        url: 'https://hn.algolia.com/api/v1/search?query=agent',
      }),
    );

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, 'Agentic workflows in production');
    assert.equal(result.articles[0].url, 'https://example.com/agentic-workflows');
  });

  it('fetch returns structured error when downstream fetch throws', async () => {
    const fetcher = new ApiFetcher(async () => {
      throw new Error('network timeout');
    });

    const result = await fetcher.fetch(createSource());

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'API_FETCH_FAILED');
    assert.match(result.errors[0].message, /network timeout/);
  });

  it('fetch includes non-2xx response body message in error payload', async () => {
    const fetcher = new ApiFetcher(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      async json() {
        return { message: 'API rate limit exceeded' };
      },
    }));

    const result = await fetcher.fetch(createSource());

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'API_FETCH_FAILED');
    assert.match(result.errors[0].message, /HTTP 403 Forbidden/);
    assert.match(result.errors[0].message, /API rate limit exceeded/);
  });

  for (const [label, options] of [
    ['no resolver', {}],
    ['an empty resolver result', { getGitHubPat: () => undefined }],
    ['a blank resolver result', { getGitHubPat: () => '   ' }],
  ]) {
    it(`does not inject environment credentials with ${label}`, async () => {
      const originalPat = process.env.GITHUB_MCP_PAT;
      process.env.GITHUB_MCP_PAT = 'environment-token-must-not-leak';
      try {
        let capturedHeaders;
        const fetcher = new ApiFetcher(async (_url, init) => {
          capturedHeaders = init?.headers;
          return createJsonResponse([]);
        }, options);

        const result = await fetcher.fetch(createSource());

        assert.equal(result.errors.length, 0);
        assert.deepEqual(capturedHeaders, { Accept: 'application/json' });
        assert.equal(process.env.GITHUB_MCP_PAT, 'environment-token-must-not-leak');
      } finally {
        if (originalPat === undefined) delete process.env.GITHUB_MCP_PAT;
        else process.env.GITHUB_MCP_PAT = originalPat;
      }
    });
  }

  it('injects only the explicitly provided GitHub token for api.github.com URLs', async () => {
    let capturedHeaders;
    const fetcher = new ApiFetcher(
      async (_url, options) => {
        capturedHeaders = options?.headers;
        return createJsonResponse([]);
      },
      { getGitHubPat: () => '  caller-provided-token  ' },
    );

    await fetcher.fetch(createSource());

    assert.deepEqual(capturedHeaders, {
      Accept: 'application/json',
      Authorization: 'Bearer caller-provided-token',
    });
  });

  it('preserves explicitly supplied source authorization without a resolver', async () => {
    let capturedHeaders;
    const fetcher = new ApiFetcher(async (_url, options) => {
      capturedHeaders = options?.headers;
      return createJsonResponse([]);
    });
    const headers = { Accept: 'application/json', Authorization: 'Bearer source-token' };

    await fetcher.fetch(createSource({ fetch: { method: 'api', headers } }));

    assert.deepEqual(capturedHeaders, headers);
  });

  it('does not resolve or inject credentials for non-GitHub, lookalike, or plaintext URLs', async () => {
    const urls = [
      'https://api.github.com.evil.tld/repos',
      'https://api.github.com@evil.tld/repos',
      'https://fake-api.github.com/repos',
      'http://api.github.com/repos',
      'https://hn.algolia.com/api/v1/search?query=agent',
    ];
    for (const url of urls) {
      let capturedHeaders;
      let resolverCalls = 0;
      const fetcher = new ApiFetcher(
        async (_url, options) => {
          capturedHeaders = options?.headers;
          return createJsonResponse([]);
        },
        {
          getGitHubPat: () => {
            resolverCalls += 1;
            return 'caller-provided-token';
          },
        },
      );

      const result = await fetcher.fetch(createSource({ url }));

      assert.equal(result.errors.length, 0);
      assert.deepEqual(capturedHeaders, { Accept: 'application/json' }, `credential leaked to ${url}`);
      assert.equal(resolverCalls, 0, `resolver must not be called for ${url}`);
    }
  });

  it('fetch rejects non-api source with clear error payload', async () => {
    const fetcher = new ApiFetcher(async () => createJsonResponse([]));

    const result = await fetcher.fetch(createSource({ fetch: { method: 'rss' } }));

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'UNSUPPORTED_SOURCE');
  });
});
