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

  it('injects GITHUB_MCP_PAT as Authorization header for api.github.com URLs', async () => {
    const originalPat = process.env.GITHUB_MCP_PAT;
    process.env.GITHUB_MCP_PAT = 'ghp_test_token_123';
    try {
      let capturedHeaders;
      const fetcher = new ApiFetcher(async (_url, options) => {
        capturedHeaders = options?.headers;
        return createJsonResponse([]);
      });

      await fetcher.fetch(createSource());

      assert.ok(capturedHeaders, 'headers must be passed to fetch');
      assert.equal(capturedHeaders.Authorization, 'Bearer ghp_test_token_123');
      assert.equal(capturedHeaders.Accept, 'application/json');
    } finally {
      if (originalPat === undefined) {
        delete process.env.GITHUB_MCP_PAT;
      } else {
        process.env.GITHUB_MCP_PAT = originalPat;
      }
    }
  });

  it('injects provided GitHub token resolver for api.github.com URLs', async () => {
    const originalPat = process.env.GITHUB_MCP_PAT;
    delete process.env.GITHUB_MCP_PAT;
    try {
      let capturedHeaders;
      const fetcher = new ApiFetcher(
        async (_url, options) => {
          capturedHeaders = options?.headers;
          return createJsonResponse([]);
        },
        { getGitHubPat: () => 'plugin-config-token' },
      );

      await fetcher.fetch(createSource());

      assert.ok(capturedHeaders, 'headers must be passed to fetch');
      assert.equal(capturedHeaders.Authorization, 'Bearer plugin-config-token');
      assert.equal(process.env.GITHUB_MCP_PAT, undefined, 'plugin resolver must not mutate process.env');
    } finally {
      if (originalPat === undefined) {
        delete process.env.GITHUB_MCP_PAT;
      } else {
        process.env.GITHUB_MCP_PAT = originalPat;
      }
    }
  });

  it('does NOT inject PAT for lookalike GitHub URLs (hostname spoofing)', async () => {
    const originalPat = process.env.GITHUB_MCP_PAT;
    process.env.GITHUB_MCP_PAT = 'ghp_test_token_123';
    try {
      const spoofUrls = [
        'https://api.github.com.evil.tld/repos',
        'https://api.github.com@evil.tld/repos',
        'https://fake-api.github.com/repos',
        'http://api.github.com/repos', // plaintext HTTP — PAT must not leak
      ];
      for (const spoofUrl of spoofUrls) {
        let capturedHeaders;
        const fetcher = new ApiFetcher(async (_url, options) => {
          capturedHeaders = options?.headers;
          return createJsonResponse([]);
        });

        await fetcher.fetch(
          createSource({
            url: spoofUrl,
            fetch: { method: 'api', headers: { Accept: 'application/json' } },
          }),
        );

        assert.equal(capturedHeaders?.Authorization, undefined, `PAT must not leak to spoofed URL: ${spoofUrl}`);
      }
    } finally {
      if (originalPat === undefined) {
        delete process.env.GITHUB_MCP_PAT;
      } else {
        process.env.GITHUB_MCP_PAT = originalPat;
      }
    }
  });

  it('does NOT inject PAT for non-GitHub API URLs', async () => {
    const originalPat = process.env.GITHUB_MCP_PAT;
    process.env.GITHUB_MCP_PAT = 'ghp_test_token_123';
    try {
      let capturedHeaders;
      const fetcher = new ApiFetcher(async (_url, options) => {
        capturedHeaders = options?.headers;
        return createJsonResponse([]);
      });

      await fetcher.fetch(
        createSource({
          url: 'https://hn.algolia.com/api/v1/search?query=agent',
          fetch: { method: 'api', headers: { Accept: 'application/json' } },
        }),
      );

      assert.ok(capturedHeaders);
      assert.equal(capturedHeaders.Authorization, undefined, 'non-GitHub URLs should not get PAT');
    } finally {
      if (originalPat === undefined) {
        delete process.env.GITHUB_MCP_PAT;
      } else {
        process.env.GITHUB_MCP_PAT = originalPat;
      }
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
