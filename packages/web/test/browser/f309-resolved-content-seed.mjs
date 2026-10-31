import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Own development instance only. Real multipart, then the original persisted message stores. */
export async function seedResolvedContent({ root, evidence, web, api, redisPort, markdownOnly = false }) {
  assert.ok(![3001, 3002].includes(Number(new URL(web).port)));
  assert.ok(![3001, 3002].includes(Number(new URL(api).port)));
  assert.ok(Number.isSafeInteger(redisPort) && redisPort > 1024 && redisPort !== 6399);
  for (const origin of [web, api]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
  const seedPath = path.join(evidence, 'seed.json');
  try {
    const prior = JSON.parse(await readFile(seedPath, 'utf8'));
    assert.equal(prior.root, root);
    assert.equal(prior.web, web);
    assert.equal(prior.api, api);
    assert.equal(prior.redisPort, redisPort);
    assert.equal(Boolean(prior.markdownOnly), markdownOnly);
    if (process.env.F309_INPUT_PATH)
      assert.equal(
        prior.samples.find((sample) => sample.id === 'md')?.sha256,
        digest(await readFile(process.env.F309_INPUT_PATH)),
      );
    for (const sample of prior.samples) assert.equal(digest(await readFile(sample.absolute)), sample.sha256);
    return prior;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path.join(evidence, 'seed-reservation.json'), JSON.stringify({ root, web, api, redisPort }), {
    flag: 'wx',
    mode: 0o600,
  });
  const sessionResponse = await fetch(`${api}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const headers = {
    Cookie: sessionResponse.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
    'x-csrf-token': session.csrfToken,
    Origin: web,
  };
  const request = async (url, init) => {
    const response = await fetch(api + url, {
      signal: AbortSignal.timeout(30000),
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    const body = await response.json();
    assert.ok(response.ok, `${url} ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const trees = await request('/api/workspace/worktrees');
  const tree = trees.worktrees.find((item) => item.root === root || item.resolvedRoot === root);
  assert.ok(tree, 'the real API must recognize this exact worktree');
  const inputs = path.join(evidence, 'inputs');
  await mkdir(inputs, { recursive: true });
  const video = path.join(inputs, `local-sample-${process.env.F309_RESOLVED_RUN ?? 'native-r1'}.mp4`);
  if (!markdownOnly) {
    execFileSync(
      '/opt/homebrew/bin/ffmpeg',
      [
        '-nostdin',
        '-n',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=12',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        video,
      ],
      { timeout: 30000 },
    );
  }
  const samples = [
    {
      id: 'md',
      name: process.env.F309_INPUT_PATH
        ? path.basename(process.env.F309_INPUT_PATH)
        : 'doc-0a6831f6718f-Clowder_AI_后续建设与分工讨论稿-v0_2.md',
      mime: 'text/markdown',
      kind: 'text',
      bytes: process.env.F309_INPUT_PATH
        ? await readFile(process.env.F309_INPUT_PATH)
        : Buffer.from('# 归一补漏的隔离样本\n\n同一份实际上传文件，经不同入口打开。\n'),
    },
    ...(!markdownOnly
      ? [
          {
            id: 'png',
            name: '共同操作图片.png',
            mime: 'image/png',
            kind: 'image',
            bytes: await readFile(path.join(root, 'docs/plans/assets/memory-delivery-roadmap/construction-map.png')),
          },
          { id: 'mp4', name: '共同操作视频.mp4', mime: 'video/mp4', kind: 'video', bytes: await readFile(video) },
          {
            id: 'docx',
            name: '真实大小文档.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            kind: 'office',
            bytes: await readFile(
              path.join(root, 'packages/web/test/browser/fixtures/f309-complex-chinese-chart.docx'),
            ),
          },
          {
            id: 'binary',
            name: '真实大小二进制.bin',
            mime: 'application/octet-stream',
            kind: 'binary',
            bytes: Buffer.alloc(8193, 0),
          },
        ]
      : []),
  ];
  const require = createRequire(path.join(root, 'packages/api/package.json'));
  const Redis = require('ioredis');
  const { RedisThreadStore } = await import(
    pathToFileURL(path.join(root, 'packages/api/dist/domains/cats/services/stores/redis/RedisThreadStore.js'))
  );
  const { RedisMessageStore } = await import(
    pathToFileURL(path.join(root, 'packages/api/dist/domains/cats/services/stores/redis/RedisMessageStore.js'))
  );
  const redis = new Redis(`redis://127.0.0.1:${redisPort}`, { keyPrefix: 'cat-cafe:', maxRetriesPerRequest: 1 });
  try {
    assert.match(await redis.info('server'), new RegExp(`tcp_port:${redisPort}\\r?\\n`));
    const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    for (const sample of samples) {
      const created = await request('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `F309 补漏实物 · ${sample.id}`,
          projectPath: root,
          preferredCats: [],
          idempotencyKey: randomUUID(),
        }),
      });
      const threadId = (created.thread ?? created).id;
      const authoritative = await threads.get(threadId);
      assert.equal(authoritative?.id, threadId, 'verify the live API store before synthetic message writes');
      assert.equal(
        authoritative?.projectPath,
        (created.thread ?? created).projectPath,
        'the live store must match the project identity admitted by the production API',
      );
      assert.equal(authoritative?.createdBy, session.userId);
      const form = new FormData();
      form.append('threadId', threadId);
      form.append('content', '本隔离开发工位的合成验收记录，不调用模型。');
      form.append('idempotencyKey', randomUUID());
      form.append('file', new Blob([sample.bytes], { type: sample.mime }), sample.name);
      const uploaded = await request('/api/messages', { method: 'POST', body: form });
      assert.equal(uploaded.entries?.length, 0);
      const human = uploaded.userMessage;
      const attachment = human.contentBlocks.find((item) => ['image', 'file'].includes(item.type));
      assert.ok(attachment);
      const facts = await request(`/api${attachment.url}/file-info`);
      // Upload storage defaults to packages/api/uploads in development and may
      // be .cat-cafe/uploads in Alpha. Both must remain inside this owned checkout.
      assert.ok(facts.path.startsWith(`${root}/`), 'uploaded bytes must stay in the owned checkout');
      assert.deepEqual(await readFile(facts.path), sample.bytes);
      const relativePath = path.relative(root, facts.path);
      const rawUrl = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: tree.id, path: relativePath })}`;
      const block = {
        kind: 'file',
        v: 1,
        id: `same-file-${sample.id}`,
        fileName: sample.name,
        url: attachment.url,
        mimeType: sample.mime,
        fileSize: sample.bytes.length,
      };
      const base = { userId: session.userId, threadId, mentions: [], from: { kind: 'agent', catId: 'codex61-sol' } };
      const agent = await messages.append({
        ...base,
        timestamp: Date.now(),
        content: '同一上传对象的合成猫卡投影。',
        extra: { rich: { v: 1, blocks: [block] } },
      });
      const raw = await messages.append({
        ...base,
        timestamp: Date.now(),
        content: '同一实际文件的 raw URL 投影；不授予原稿权限。',
        extra: { rich: { v: 1, blocks: [{ ...block, id: `same-raw-${sample.id}`, url: rawUrl }] } },
      });
      Object.assign(sample, {
        threadId,
        path: relativePath,
        absolute: facts.path,
        url: attachment.url,
        rawUrl,
        size: sample.bytes.length,
        sha256: digest(sample.bytes),
        agentMessageId: agent.id,
        rawMessageId: raw.id,
        humanMessageId: human.id,
        humanBlockType: attachment.type,
      });
      delete sample.bytes;
      await writeFile(
        path.join(evidence, 'seed-progress.json'),
        JSON.stringify(
          samples.filter((item) => item.threadId),
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
    const seed = {
      root,
      web,
      api,
      redisPort,
      markdownOnly,
      worktreeId: tree.id,
      samples,
      routeMocks: 0,
      modelInvocations: 0,
      kind: 'isolated development worktree, real multipart and original stores',
    };
    await writeFile(seedPath, JSON.stringify(seed, null, 2), { flag: 'wx', mode: 0o600 });
    return seed;
  } finally {
    await redis.quit();
  }
}
