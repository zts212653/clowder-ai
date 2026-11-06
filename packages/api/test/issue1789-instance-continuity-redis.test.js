import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import Redis from 'ioredis';
import sharp from 'sharp';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { linkedRootConfigPath } from '../dist/domains/workspace/roots/workspace-linked-root-store.js';
import { issueRootConnectionProof } from '../dist/domains/workspace/roots/workspace-root-proof.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { threadsRoutes } from '../dist/routes/threads.js';
import { uploadsRoutes } from '../dist/routes/uploads.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;

test(
  'historical references, workspace discovery and upload storage are independent',
  {
    skip: redisIsolationSkipReason(redisUrl),
  },
  async (t) => {
    assertRedisIsolationOrThrow(redisUrl, 'Issue1789InstanceContinuity');
    const originalCwd = process.cwd();
    const fixtureDir = await mkdtemp(join(await realpath(tmpdir()), 'clowder-issue1789-'));
    const apps = [];
    let redis;
    t.after(async () => {
      process.chdir(originalCwd);
      const closed = await Promise.allSettled([...apps.map((app) => app.close()), redis?.quit()]);
      await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
      assert.deepEqual(
        closed.filter((result) => result.status === 'rejected'),
        [],
      );
    });
    const root = await realpath(fixtureDir);
    const desktop = join(root, 'desktop');
    const project = join(desktop, 'project');
    const uploads = join(desktop, 'uploads');
    const repo = join(root, 'source');
    const legacy = join(root, 'legacy-worktree');
    const oldUploads = join(root, 'previous', 'uploads');
    const desktopRedis = join(desktop, 'data', 'redis');
    await Promise.all([project, uploads, repo, oldUploads, desktopRedis].map((dir) => mkdir(dir, { recursive: true })));
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    git('worktree', 'add', '--detach', legacy);
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3a7450' } })
      .png()
      .toBuffer();
    const doc = Buffer.from('synthetic old upload');
    await writeFile(join(legacy, 'valid image.png'), image);
    await writeFile(join(legacy, 'broken.png'), 'not a PNG');
    await writeFile(join(oldUploads, 'old.txt'), doc);

    process.chdir(project);
    process.env.CAT_CAFE_WORKSPACE_ROOT = project;
    process.env.CAT_CAFE_CONFIG_ROOT = project;
    process.env.CAT_CAFE_DATA_DIR = join(desktop, 'data');
    delete process.env.WORKSPACE_LINKED_ROOTS;

    // Reproduce the mixed data plane explicitly, independent of desktop startup policy.
    redis = new Redis(redisUrl, { keyPrefix: `issue1789-${process.pid}:` });
    const [, reportedDir] = await redis.config('GET', 'dir');
    const redisDirectory =
      process.platform === 'win32' ? reportedDir.replace(/^\/cygdrive\/([a-z])\//i, '$1:/') : reportedDir;
    assert.notEqual(await realpath(redisDirectory), await realpath(desktopRedis));
    const threadStore = new RedisThreadStore(redis);
    const messageStore = new RedisMessageStore(redis);
    const userId = 'fixture-owner';
    const headers = { host: 'localhost', 'x-cat-cafe-user': userId };
    const thread = await threadStore.create(userId, 'Historical thread', repo);
    const raw = (id, file) => `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: id, path: file })}`;
    const imageUrl = raw('legacy-worktree', 'valid image.png');
    const uploadUrl = '/uploads/old.txt';
    const blocks = [
      { kind: 'media_gallery', v: 1, id: 'image', items: [{ url: imageUrl, alt: 'Legacy image' }] },
      { kind: 'file', v: 1, id: 'doc', url: uploadUrl, fileName: 'old.txt', mimeType: 'text/plain' },
    ];
    await messageStore.append({
      threadId: thread.id,
      userId,
      from: { kind: 'agent', catId: 'codex-sol' },
      content: 'Original delivery',
      mentions: [],
      timestamp: Date.now(),
      extra: { rich: { v: 1, blocks } },
    });

    const start = async (uploadDir) => {
      const app = Fastify();
      apps.push(app);
      await app.register(threadsRoutes, { threadStore, messageStore });
      await app.register(messagesRoutes, { threadStore, messageStore, registry: new InvocationRegistry() });
      await app.register(workspaceRoutes);
      await app.register(uploadsRoutes, { uploadDir });
      return app;
    };
    const app = await start(uploads);
    const get = (url) => app.inject({ url, headers });
    const home = await get('/api/artifacts?view=recent-works&limit=3');
    const chat = await get(`/api/messages?threadId=${thread.id}`);
    assert.equal(home.statusCode, 200, home.body);
    assert.equal(chat.statusCode, 200, chat.body);
    assert.deepEqual(new Set(home.json().artifacts.map((artifact) => artifact.url)), new Set([imageUrl, uploadUrl]));
    assert.deepEqual(
      chat.json().messages[0].extra.rich.blocks.map((block) => block.url ?? block.items[0].url),
      [imageUrl, uploadUrl],
    );
    t.diagnostic('Home and Chat return history from the fixture Redis while the file roots belong to another instance');

    const missingRoot = await get(imageUrl);
    assert.equal(missingRoot.statusCode, 404);
    assert.match(missingRoot.json().error, /^Worktree not found/);
    process.chdir(repo);
    assert.deepEqual((await get(imageUrl)).rawPayload, image);
    process.chdir(project);
    t.diagnostic('The bare legacy alias fails in non-Git cwd and reads the same PNG from Git cwd');

    const missingUpload = await get(uploadUrl);
    assert.equal(missingUpload.statusCode, 404);
    assert.deepEqual(await readFile(join(oldUploads, 'old.txt')), doc);
    const oldUploadApp = await start(oldUploads);
    assert.deepEqual((await oldUploadApp.inject({ url: uploadUrl, headers })).rawPayload, doc);
    t.diagnostic('The same upload URL returns 404 from the current root and exact bytes from the former root');

    const selected = await realpath(legacy);
    const selection = { userId, root: selected, expectedEpoch: 0, source: { kind: 'directory-selection' } };
    const payload = { root: selected, operationId: 'fixture-grant', expectedEpoch: 0, expectedUserId: userId };
    const connect = (connectionProof) =>
      app.inject({
        method: 'POST',
        url: '/api/workspace/root-connections',
        headers,
        payload: { ...payload, connectionProof },
      });
    assert.equal((await connect('forged')).statusCode, 409);
    assert.equal((await get(imageUrl)).statusCode, 404);
    const grant = await connect(issueRootConnectionProof(selection));
    assert.equal(grant.statusCode, 200, grant.body);
    const id = grant.json().linked.id;
    assert.equal((await get(imageUrl)).statusCode, 404, 'connecting a root does not claim a bare legacy alias');
    assert.deepEqual((await get(raw(id, 'valid image.png'))).rawPayload, image);
    const missingFile = await get(raw(id, 'absent.png'));
    assert.equal(missingFile.statusCode, 404);
    assert.equal(missingFile.json().error, 'File not found');
    const broken = await get(raw(id, 'broken.png'));
    assert.equal(broken.statusCode, 200);
    await assert.rejects(sharp(broken.rawPayload).metadata());
    const configFile = linkedRootConfigPath();
    const persisted = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(persisted.roots[0].id, id);
    // Model an already-authorized legacy mapping in the synthetic config.
    // The connection API above deliberately does not create this mapping.
    persisted.roots[0].legacyAliases = ['legacy-worktree'];
    await writeFile(configFile, JSON.stringify(persisted));
    await app.close();
    const resolver = new URL('../dist/domains/workspace/workspace-security.js', import.meta.url).href;
    const reloadedRoot = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const { getWorktreeRoot } = await import(process.argv[1]); console.log(await getWorktreeRoot(process.argv[2]));',
        resolver,
        'legacy-worktree',
      ],
      { cwd: project, encoding: 'utf8' },
    ).trim();
    assert.equal(reloadedRoot, selected);
    const restarted = await start(oldUploads);
    assert.deepEqual((await restarted.inject({ url: imageUrl, headers })).rawPayload, image);
    assert.deepEqual((await restarted.inject({ url: uploadUrl, headers })).rawPayload, doc);
    t.diagnostic('A persisted synthetic alias and explicit upload root both return original bytes after reload');
  },
);
