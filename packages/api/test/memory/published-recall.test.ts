import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemoryServices } from '../../dist/domains/memory/factory.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { KnowledgeAssociations } from '../../dist/domains/memory/knowledge-associations.js';
import { PublishedDocumentIndex } from '../../dist/domains/memory/PublishedDocumentIndex.js';
import { PublishedDocumentSource } from '../../dist/domains/memory/PublishedDocumentSource.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { resolveMemoryRepoPaths } from '../../dist/utils/memory-root.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('runtime knowledge uses the workspace docs while persistence stays at the runtime root', () => {
  const root = mkdtempSync(join(tmpdir(), 'f332-roots-'));
  try {
    const runtime = join(root, 'runtime');
    const workspace = join(root, 'workspace');
    for (const dir of [runtime, workspace]) {
      mkdirSync(join(dir, 'packages/api'), { recursive: true });
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    }
    const result = resolveMemoryRepoPaths(join(runtime, 'packages/api'), { CAT_CAFE_WORKSPACE_ROOT: workspace });
    assert.equal(result.repoRoot, runtime, 'this repair must not silently migrate the evidence DB');
    assert.equal(result.docsRoot, join(workspace, 'docs'));
    assert.equal(
      resolveMemoryRepoPaths(runtime, { CAT_CAFE_WORKSPACE_ROOT: workspace, DOCS_ROOT: '/configured/docs' }).docsRoot,
      '/configured/docs',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('published Git docs exclude dirty and untracked material without changing the checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f332-published-'));
  try {
    const remote = join(root, 'remote.git');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(workspace, 'init', '--initial-branch=main');
    git(workspace, 'config', 'user.name', 'F332 fixture');
    git(workspace, 'config', 'user.email', 'f332@example.invalid');
    mkdirSync(join(workspace, 'docs/features'), { recursive: true });
    const path = join(workspace, 'docs/features/F999-published.md');
    writeFileSync(path, '# ReleaseMemoryQuasar\n\nPublished understanding.\n');
    git(workspace, 'add', 'docs');
    git(workspace, '-c', 'commit.gpgsign=false', 'commit', '-m', 'publish source');
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'push', '-u', 'origin', 'main');
    writeFileSync(path, '# DraftAccretionX\n\nNot published.\n');
    writeFileSync(join(workspace, 'docs/features/draft.md'), '# UntrackedNebulaY\n');
    const before = git(workspace, 'status', '--porcelain');
    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: join(root, 'evidence.sqlite'),
      docsRoot: join(workspace, 'docs'),
      ...{ publishedProjectRoot: workspace },
      dataDir: join(root, 'data'),
      globalDbPath: join(root, 'global.sqlite'),
      skillsRoot: join(root, 'skills'),
      memoryRoot: join(root, 'memory'),
      includeRosterEntitySeeds: false,
      embed: { embedMode: 'off' },
    });
    try {
      await services.indexBuilder!.rebuild({ deferThreadIndexing: true });
      assert.equal((await services.store.search('ReleaseMemoryQuasar')).length, 1);
      assert.equal((await services.store.search('DraftAccretionX')).length, 0);
      assert.equal((await services.store.search('UntrackedNebulaY')).length, 0);
      assert.equal(git(workspace, 'status', '--porcelain'), before);
      assert.match(readFileSync(path, 'utf8'), /DraftAccretionX/);
      const initial = (await services.store.search('ReleaseMemoryQuasar'))[0];
      assert.equal((await services.publishedDocuments!.read(initial.anchor, initial.sourceHash!)).status, 'ready');
      const completeUpsert = services.store.upsertForDocumentIndex.bind(services.store);
      services.store.upsertForDocumentIndex = async (item) => {
        await completeUpsert(item);
        throw new Error('interrupted same-version rebuild after metadata');
      };
      await assert.rejects(services.indexBuilder!.rebuild({ force: true }), /interrupted same-version rebuild/);
      services.store.upsertForDocumentIndex = completeUpsert;
      await (services.indexBuilder as IndexBuilder).refreshPublishedDocuments();
      assert.equal(
        (await services.publishedDocuments!.read(initial.anchor, initial.sourceHash!)).status,
        'ready',
        'an unchanged publication still repairs incomplete passages left by an interrupted rebuild',
      );
      const olderSnapshot = await services.publishedDocuments!.open();
      services.publishedDocuments!.markPending();
      await services.publishedDocuments!.commit(olderSnapshot);
      assert.equal(
        services.publishedDocuments!.getStatus().state,
        'pending',
        'finishing an older batch must not clear a newer publication notice',
      );
      await (services.indexBuilder as IndexBuilder).refreshPublishedDocuments();
      const publisher = join(root, 'publisher');
      git(root, 'clone', remote, publisher);
      git(publisher, 'config', 'user.name', 'F332 fixture');
      git(publisher, 'config', 'user.email', 'f332@example.invalid');
      const publishedPath = join(publisher, 'docs/features/F999-published.md');
      let initialRefresh: () => void = () => {};
      let updatedRefresh: () => void = () => {};
      const initiallyObserved = new Promise<void>((resolve) => {
        initialRefresh = resolve;
      });
      const automaticallyUpdated = new Promise<void>((resolve) => {
        updatedRefresh = resolve;
      });
      services.publishedDocuments!.start(async () => {
        await (services.indexBuilder as IndexBuilder).refreshPublishedDocuments(true);
        initialRefresh();
        if ((await services.store.search('RevisedOrbitSource')).length) updatedRefresh();
      }, 10);
      await initiallyObserved;
      writeFileSync(publishedPath, '# RevisedOrbitSource\n\nCurrent approved knowledge.\n');
      git(publisher, 'add', 'docs');
      git(publisher, '-c', 'commit.gpgsign=false', 'commit', '-m', 'revise source');
      git(publisher, 'push', 'origin', 'main');
      await automaticallyUpdated;
      await services.publishedDocuments!.stop();
      assert.equal((await services.store.search('RevisedOrbitSource')).length, 1);
      assert.equal((await services.store.search('ReleaseMemoryQuasar')).length, 0);
      assert.equal(
        (await services.publishedDocuments!.read(initial.anchor, initial.sourceHash!)).status,
        'source_changed',
      );
      assert.equal(git(workspace, 'status', '--porcelain'), before);

      const goodCheckpoint = services.publishedDocuments!.getStatus().indexedVersion;
      writeFileSync(publishedPath, '# DurableRecoverySatellite\n');
      git(publisher, 'add', 'docs');
      git(publisher, '-c', 'commit.gpgsign=false', 'commit', '-m', 'publish during interruption');
      git(publisher, 'push', 'origin', 'main');
      const normalUpsert = services.store.upsertForDocumentIndex.bind(services.store);
      services.store.upsertForDocumentIndex = async () => {
        throw new Error('injected interrupted write');
      };
      await assert.rejects(
        (services.indexBuilder as IndexBuilder).refreshPublishedDocuments(true),
        /interrupted write/,
      );
      assert.equal(services.publishedDocuments!.getStatus().state, 'degraded');
      assert.equal(services.publishedDocuments!.getStatus().indexedVersion, goodCheckpoint);
      services.store.upsertForDocumentIndex = normalUpsert;
      services.store.close();
      const reopened = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
      await reopened.initialize();
      const recovered = new PublishedDocumentIndex(new PublishedDocumentSource(workspace), reopened);
      const recoveryBuilder = new IndexBuilder(
        reopened,
        join(workspace, 'docs'),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        recovered,
      );
      try {
        await recoveryBuilder.refreshPublishedDocuments();
        assert.equal((await reopened.search('DurableRecoverySatellite')).length, 1);
        assert.equal(recovered.getStatus().state, 'up_to_date');
        git(publisher, 'rm', 'docs/features/F999-published.md');
        git(publisher, '-c', 'commit.gpgsign=false', 'commit', '-m', 'remove source');
        git(publisher, 'push', 'origin', 'main');
        await recoveryBuilder.refreshPublishedDocuments(true);
        assert.equal((await reopened.search('DurableRecoverySatellite')).length, 0);
        assert.equal((await recovered.read(initial.anchor, initial.sourceHash!)).status, 'unavailable');
        assert.equal(git(workspace, 'status', '--porcelain'), before);
      } finally {
        reopened.close();
      }
    } finally {
      await services.publishedDocuments?.stop();
      await services.embeddingLifecycle.deactivate();
      await services.store.close();
      await services.globalStore?.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a ranked result with generic section headings does not invent related directions', async () => {
  const probes: string[] = [];
  const item = {
    anchor: 'doc:template',
    title: 'Unrelated template',
    summary: 'A generic template',
    kind: 'plan' as const,
    status: 'active' as const,
    updatedAt: '2026-11-05',
    keywords: ['背景', '验收', '风险', 'Summary'],
  };
  const service = new KnowledgeAssociations({
    searchWithMeta: async (query) => {
      probes.push(query);
      return { items: [{ ...item, anchor: 'doc:unrelated' }], meta: { degraded: false } };
    },
  });
  const result = await service.expand([item], '不存在的专有术语Quasar');
  assert.deepEqual(probes, []);
  assert.deepEqual(result, []);
});

test('exact anchors do not turn common headings into topics or invent source-thread edges', async () => {
  const probes: string[] = [];
  const seed = {
    anchor: 'F100',
    title: 'F100',
    kind: 'feature' as const,
    status: 'active' as const,
    updatedAt: '2026-11-05',
    keywords: ['验收'],
    summary: 'Source: thread-thread_target',
  };
  const service = new KnowledgeAssociations({
    searchWithMeta: async (query, options) => {
      probes.push(query);
      return {
        items: options?.scope === 'threads' ? [{ ...seed, kind: 'thread' as const, anchor: 'thread-unrelated' }] : [],
        meta: { degraded: false },
      };
    },
  });
  const hints = await service.expand([seed], 'F100 验收');
  assert.ok(!probes.includes('验收'), 'a section label is not a topic expansion seed');
  assert.deepEqual(hints, [], 'ranked thread neighbours are not the source thread');
});

test('multiword and natural questions retain query-supported keywords without expanding section labels', async () => {
  const seed = {
    anchor: 'doc:reviewer-video',
    title: '审稿人系列视频制作规范',
    summary: '审稿人系列视频要做好，先看 Taste',
    keywords: ['审稿人', '视频', 'Taste', '验收'],
    kind: 'research' as const,
    status: 'active' as const,
    updatedAt: '2026-11-05',
  };
  const service = new KnowledgeAssociations({
    searchWithMeta: async (term) => ({
      items: [{ ...seed, anchor: `doc:related-${term}`, title: `${term} 的来源`, keywords: [term] }],
      meta: { degraded: false },
    }),
  });
  for (const query of ['审稿人 视频', '昨天审稿人系列视频怎样才做得好', '审稿人 视频 验收']) {
    const hints = await service.expand([seed], query);
    assert.deepEqual(
      hints.map((hint) => hint.provenance.via),
      ['keyword:审稿人', 'keyword:视频'],
    );
  }
});
