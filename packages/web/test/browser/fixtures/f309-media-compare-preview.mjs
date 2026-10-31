import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startReviewHost } from './f309-artifact-review-host.mjs';
import { mediaFixture } from './f309-artifact-review-media.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '3337' },
    kind: { type: 'string', default: 'png' },
    'data-dir': { type: 'string' },
  },
});
const port = Number(values.port),
  kind = values.kind;
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(![3001, 3002, 3011, 3012, 4111, 6397, 6398, 6399].includes(port));
assert.ok(['png', 'mp4'].includes(kind));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.REDIS_URL, 'redis://localhost:6398');
assert.notEqual(process.env.CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD, '1');
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim(),
  '',
  'Commit the preview sources before labeling its exact client revision.',
);
const clientRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const parent = path.resolve(values['data-dir'] ?? path.join(repository, 'var/f309-k3-preview'));
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, `${kind}-session-`));
for (const version of [1, 2]) {
  if (kind === 'mp4') await mediaFixture(root, kind, version);
  else
    await copyFile(
      path.join(
        repository,
        'docs/evidence/2026-09-29-f309-studio-northstar/mock',
        version === 1
          ? 'f323-phase-a-design-mobile-e2869df73c14cdae.png'
          : 'f323-phase-a-design-mobile-review-r2-20260928-2e688e95.png',
      ),
      path.join(root, version === 1 ? 'review-input.png' : 'review-response.png'),
    );
}
const host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4', { port, clientRevision });
try {
  const prepared = await host.reviews.prepare(host.prepare, host.human);
  const reviewId = prepared.review.reviewId,
    published = host.publish(`review-response.${kind}`);
  await host.catCallback('respond', {
    reviewId,
    expectedRevision: prepared.review.revision,
    expectedTaskRevision: 1,
    expectedOwnerRevision: 1,
    operationId: 'preview-version',
    artifactRef: `/uploads/review-response.${kind}`,
    expectedArtifactRevision: String(published.timestamp),
    responses: [],
  });
  await host.lifecycle.update({
    taskId: host.taskId,
    expectedRevision: 1,
    artifactRefs: [`content:${prepared.review.contentRef}`],
  });
  const view = await host.reviews.read(reviewId, host.cat);
  await host.catCallback('act', {
    reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: 2,
    round: 2,
    operationId: 'preview-judgment',
    action: {
      kind: 'request_judgment',
      summary: '对照原版与候选，再给出这一版的审阅结论。',
      judgmentNeeded: '通过此版本或要求修改；不会写回文件或关闭Task。',
    },
  });
  const receipt = {
    kind: 'isolated-k3-media-compare',
    media: kind,
    clientRevision,
    origin: host.origin,
    apiOrigin: host.apiOrigin,
    root,
    threadId: host.thread.id,
    taskId: host.taskId,
    reviewId,
    entry: 'Schedule → 审阅产物 → 当前第2版 → 对比。返回作品恢复同一画布，返回来源交还Schedule。',
    boundary:
      'Production F307 surface/review/publication components and isolated real SQLite owners; generated fixture Task only, no runtime data. Each restart creates a new session; prior SQLite and browser drafts are retained, not rebound.',
  };
  await writeFile(path.join(root, 'preview.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(path.join(parent, `${kind}-current.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} catch (error) {
  await host.close();
  throw error;
}
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await host.close();
    process.exit(0);
  });
