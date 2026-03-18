/**
 * Route integration test: POST /api/signals/articles/:id/discuss
 *
 * Uses real Fastify app.inject() with monkey-patched services
 * to verify study thread creation/reuse behaviour.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { signalStudyRoutes } = await import('../dist/routes/signal-study-routes.js');
const { SignalArticleQueryService } = await import('../dist/domains/signals/services/article-query-service.js');
const { StudyMetaService } = await import('../dist/domains/signals/services/study-meta-service.js');

describe('POST /api/signals/articles/:id/discuss (real Fastify inject)', () => {
  let tmpDir;
  let app;
  let origGetArticle;
  let origReadMeta;
  let origLinkThread;
  let threadCreated;

  const FAKE_ARTICLE = {
    id: 'art-1',
    url: 'https://example.com',
    title: 'Building Multi-Agent Systems',
    source: 'test',
    tier: 1,
    publishedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    status: 'inbox',
    tags: [],
    filePath: '', // set in beforeEach
    content: '# Body',
  };

  /** Minimal stub that satisfies IThreadStore for this route */
  function makeThreadStore() {
    threadCreated = null;
    return {
      create(userId, title) {
        threadCreated = { userId, title };
        return {
          id: 'thread-new-1',
          title,
          createdBy: userId,
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        };
      },
      addParticipants() {},
    };
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'discuss-route-test-'));
    process.env.SIGNALS_ROOT_DIR = tmpDir;

    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    mkdirSync(join(tmpDir, 'library'), { recursive: true });
    mkdirSync(join(tmpDir, 'inbox'), { recursive: true });
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    writeFileSync(join(tmpDir, 'config', 'sources.yaml'), '# empty\nsources: []\n');

    FAKE_ARTICLE.filePath = join(tmpDir, 'library', 'art-1.md');
    writeFileSync(FAKE_ARTICLE.filePath, '# Body');

    origGetArticle = SignalArticleQueryService.prototype.getArticleById;
    origReadMeta = StudyMetaService.prototype.readMeta;
    origLinkThread = StudyMetaService.prototype.linkThread;

    SignalArticleQueryService.prototype.getArticleById = async (id) => (id === 'art-1' ? FAKE_ARTICLE : null);

    app = Fastify();
    await app.register(signalStudyRoutes, { threadStore: makeThreadStore() });
    await app.ready();
  });

  afterEach(async () => {
    SignalArticleQueryService.prototype.getArticleById = origGetArticle;
    StudyMetaService.prototype.readMeta = origReadMeta;
    StudyMetaService.prototype.linkThread = origLinkThread;
    await app.close();
    delete process.env.SIGNALS_ROOT_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 401 without identity header', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/signals/articles/art-1/discuss' });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 for unknown article', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/signals/articles/nonexistent/discuss',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('creates a new study thread when none linked', async () => {
    // readMeta returns empty threads
    StudyMetaService.prototype.readMeta = async () => ({
      articleId: 'art-1',
      threads: [],
      artifacts: [],
      collections: [],
    });
    StudyMetaService.prototype.linkThread = async () => ({
      articleId: 'art-1',
      threads: [{ threadId: 'thread-new-1', linkedBy: 'test-user', linkedAt: new Date().toISOString() }],
      artifacts: [],
      collections: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/signals/articles/art-1/discuss',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-new-1');
    assert.ok(threadCreated, 'thread should have been created');
    assert.equal(threadCreated.title, 'Study: Building Multi-Agent Systems');
  });

  it('returns existing thread when one is already linked', async () => {
    StudyMetaService.prototype.readMeta = async () => ({
      articleId: 'art-1',
      threads: [{ threadId: 'thread-existing', linkedBy: 'user', linkedAt: new Date().toISOString(), stale: false }],
      artifacts: [],
      collections: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/signals/articles/art-1/discuss',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-existing');
    assert.equal(threadCreated, null, 'should NOT create a new thread');
  });
});
