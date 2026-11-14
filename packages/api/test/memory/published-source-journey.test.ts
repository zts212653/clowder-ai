import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { handleSearchEvidence } from '../../../mcp-server/dist/tools/evidence-tools.js';
import { handleReadFileSlice } from '../../../mcp-server/dist/tools/file-tools.js';
import { withInvocationCredentials } from '../../../mcp-server/dist/tools/invocation-auth.js';
import { createMemoryServices } from '../../dist/domains/memory/factory.js';
import { evidenceRoutes } from '../../dist/routes/evidence.js';
import { createRemoteFixture, git } from '../taste-publication-fixtures.js';

test('MCP search → versioned source read shares the publication and preserves read permissions', async () => {
  const f = createRemoteFixture();
  const savedFetch = globalThis.fetch;
  const savedDirs = process.env.ALLOWED_WORKSPACE_DIRS;
  const app = Fastify();
  mkdirSync(join(f.primary, 'docs/features'), { recursive: true });
  const path = join(f.primary, 'docs/features/short.md');
  writeFileSync(path, '# 短锚点\n\nPublishedQuasarDecision\n');
  mkdirSync(join(f.primary, 'docs/taste/vignettes'), { recursive: true });
  const publicTaste =
    '---\nwhen: 2026-11-05\nquotes: [PrivateQuasarLeak]\nscene: PrivateQuasarLeak\ntags: [private]\nprivacy: sensitive\n---\n';
  writeFileSync(join(f.primary, 'docs/taste/vignettes/private.md'), publicTaste);
  writeFileSync(
    join(f.primary, 'docs/taste/vignettes/pending.md'),
    publicTaste
      .replaceAll('PrivateQuasarLeak', 'PendingQuasarLeak')
      .replace('privacy: sensitive', 'privacy: public\nstatus: pending'),
  );
  git(f.primary, ['add', 'docs']);
  git(f.primary, ['commit', '-m', 'publish documents']);
  git(f.primary, ['push', 'origin', 'main']);
  writeFileSync(path, '# WrongLocalDraft\n');
  const services = await createMemoryServices({
    type: 'sqlite',
    docsRoot: join(f.primary, 'docs'),
    publishedProjectRoot: f.primary,
    sqlitePath: ':memory:',
    dataDir: join(f.root, 'data'),
    globalDbPath: join(f.root, 'global.sqlite'),
    skillsRoot: join(f.root, 'skills'),
    memoryRoot: join(f.root, 'memory'),
    includeRosterEntitySeeds: false,
    embed: { embedMode: 'off' },
    privateUserId: 'source-owner',
  });
  try {
    await services.indexBuilder!.rebuild({ deferThreadIndexing: true });
    await app.register(evidenceRoutes, {
      evidenceStore: services.store,
      indexBuilder: services.indexBuilder,
      publishedDocuments: services.publishedDocuments,
      publishedOwnerUserId: 'source-owner',
    });
    await app.ready();
    const readResponse = await app.inject('/api/evidence/search?q=' + encodeURIComponent('短锚点'));
    assert.equal(readResponse.statusCode, 200);
    const result = readResponse.json().results[0];
    assert.equal(result.relevance.state, 'exact_title');
    assert.equal(readResponse.json().sourceProjection.state, 'up_to_date');
    const uri = result.drillDown.params.path;
    const sourceUrl =
      '/api/evidence/published-source?' +
      new URLSearchParams({
        anchor: result.anchor,
        sourceHash: result.sourceHash,
        startLine: '1',
        endLine: '4',
      });
    assert.equal((await app.inject(sourceUrl)).statusCode, 401);
    assert.equal(
      (await app.inject({ url: sourceUrl, headers: { 'x-cat-cafe-user': 'another-owner' } })).statusCode,
      403,
    );
    assert.equal((await services.store.search('PrivateQuasarLeak')).length, 0);
    assert.equal((await services.store.search('PendingQuasarLeak')).length, 0);

    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url));
      const response = await app.inject({
        url: parsed.pathname + parsed.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    process.env.ALLOWED_WORKSPACE_DIRS = f.primary;
    await withInvocationCredentials(
      { invocationId: undefined, callbackToken: undefined, userId: 'source-owner', apiUrl: 'http://localhost' },
      async () => {
        const search = await handleSearchEvidence({ query: '短锚点', scope: 'docs' });
        assert.match(search.content[0].text, /exact_title/);
        assert.ok(search.content[0].text.includes(uri));
        const read = await handleReadFileSlice({ path: uri, startLine: 1, endLine: 4 });
        assert.equal(read.isError, undefined);
        assert.match(read.content[0].text, /PublishedQuasarDecision/);
        assert.doesNotMatch(read.content[0].text, /WrongLocalDraft/);
        process.env.ALLOWED_WORKSPACE_DIRS = f.runtime;
        const denied = await handleReadFileSlice({ path: uri, startLine: 1 });
        assert.equal(denied.isError, true);
        assert.doesNotMatch(denied.content[0].text, /PublishedQuasarDecision/);
      },
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedDirs === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
    else process.env.ALLOWED_WORKSPACE_DIRS = savedDirs;
    await app.close();
    await services.publishedDocuments?.stop();
    await services.embeddingLifecycle.deactivate();
    services.store.close();
    services.globalStore?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
