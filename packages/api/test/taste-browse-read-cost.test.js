import { createTasteBrowseFixture } from './helpers/taste-browse-fixture.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { FileTasteRepository } from '../dist/domains/taste/services/TasteRepository.js';
import { tasteBrowseRoutes } from '../dist/routes/taste-browse.js';
import { tasteMemoryId, visibleTasteMemories } from '../dist/routes/taste-browse-model.js';

const paths = Array.from({ length: 12 }, (_, i) => `docs/taste/vignettes/fixture-${i}.md`);
const vignette = (quote) =>
  `---\nwhen: 2026-01-01\nquotes: ["${quote}"]\nscene: "synthetic scene"\ntags: [fixture]\nprivacy: public\nproposalId: fixture-proposal\n---\n`;

test('a single revision-bound source reads only its target instead of every approved payload', async () => {
  const reads = [];
  const contents = new Map(paths.map((path, i) => [path, vignette(`fixture ${i}`)]));
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'];
  });
  await app.register(tasteBrowseRoutes, {
    ownerUserId: 'owner',
    browse: createTasteBrowseFixture({
      canonicalRoot: () => '/unused-published-fixture',
      approvalLockKey: () => 'unused',
      publishedSnapshot: async () => ({
        list: async () => paths,
        read: async (path) => {
          reads.push(path);
          return contents.get(path) ?? null;
        },
      }),
    }),
    readObservatory: async () => ({ entries: [], coverage: { totalUnverified: 0 } }),
    proposalStore: {
      get: async () => ({
        userId: 'owner',
        status: 'approved',
        vignettePath: paths[7],
        sourceMessageId: 'fixture-message',
        threadId: 'fixture-thread',
      }),
    },
    threadStore: {
      get: async () => ({ id: 'fixture-thread', createdBy: 'owner', title: 'fixture source' }),
      list: async () => [],
    },
    messageStore: {
      getById: async () => ({
        id: 'fixture-message',
        threadId: 'fixture-thread',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        catId: null,
        content: 'fixture',
        timestamp: 1,
      }),
    },
  });
  try {
    const entries = (await app.inject({ url: '/api/memory/taste', headers: { 'x-test-session': 'owner' } })).json()
      .entries;
    const target = entries.find((entry) => entry.id === tasteMemoryId(paths[7]));
    assert.ok(target);
    reads.length = 0;
    const response = await app.inject({
      url: `/api/memory/taste/${target.id}/source?revision=${encodeURIComponent(target.revision)}`,
      headers: { 'x-test-session': 'owner' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ready');
    assert.deepEqual(reads, [paths[7]], 'unrelated Taste payloads must not be read for one source');
    console.log(JSON.stringify({ claim: 'single-source-payload-reads', payloadReads: reads.length }));
  } finally {
    await app.close();
  }
});

test('published browse reads a corpus without starting a Git process for every vignette', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f321-taste-cost-'));
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Synthetic fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    for (const [i, path] of paths.entries()) writeFileSync(join(root, path), vignette(`fixture ${i}`));
    // Former single-file reads skipped over-budget files; one malformed blob must not hide valid neighbours.
    writeFileSync(join(root, 'docs/taste/vignettes/over-budget.md'), 'x'.repeat(17 * 1024 * 1024));
    git('add', '.');
    git('commit', '-m', 'synthetic Taste fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const trace = join(root, 'git-trace.jsonl');
    process.env.GIT_TRACE2_EVENT = trace;
    const memories = await visibleTasteMemories(new FileTasteRepository(root), 'owner', false);
    assert.equal(memories.length, paths.length);
    const commands = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start')
      .map((event) => event.argv[1]);
    assert.equal(commands.filter((name) => name === 'cat-file').length, 1, commands.join(', '));
    assert.ok(commands.length <= 9, `corpus spawned ${commands.length} Git processes`);
    console.log(
      JSON.stringify({
        claim: 'published-corpus-git-cost',
        entries: memories.length,
        catFileProcesses: commands.filter((name) => name === 'cat-file').length,
        gitProcesses: commands.length,
        overBudgetNeighbourSkipped: true,
      }),
    );
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    rmSync(root, { recursive: true, force: true });
  }
});
