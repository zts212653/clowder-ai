import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { PublishedMediaService } from '../../src/domains/video-studio/content-owner/published-media-service.js';
import {
  type ArtifactReviewRoutesDeps,
  registerArtifactReviewRoutes,
} from '../../src/routes/artifact-review-routes.js';
import { registerPublishedContentRoutes } from '../../src/routes/published-content-routes.js';

export async function fileActionHarness(t: TestContext, media: PublishedMediaService, asset: ReviewedMediaAsset) {
  return nativeActionHarness(
    t,
    (app) => registerPublishedContentRoutes(app, { media }),
    `/api/content-publications/${encodeURIComponent(asset.contentRef)}/media/${asset.ownerRevision}`,
  );
}

export async function reviewFileActionHarness(
  t: TestContext,
  deps: ArtifactReviewRoutesDeps,
  reviewId: string,
  round: number,
) {
  return nativeActionHarness(
    t,
    (app) => registerArtifactReviewRoutes(app, deps),
    `/api/artifact-reviews/${encodeURIComponent(reviewId)}/media/${round}`,
  );
}

async function nativeActionHarness(t: TestContext, register: (app: FastifyInstance) => void, base: string) {
  const directory = await mkdtemp(join(tmpdir(), 'media-action-record-'));
  const log = join(directory, 'open.argv');
  await writeFile(join(directory, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
  await writeFile(
    join(directory, 'osascript'),
    `#!/bin/sh\ncase "$5" in\nvideo/mp4) echo '{"path":"/System/Applications/QuickTime Player.app","name":"QuickTime Player"}';;\n*) echo '{"path":"/System/Applications/Preview.app","name":"Preview"}';;\nesac\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${directory}:${previous}`;
  const app = Fastify();
  register(app);
  t.after(async () => {
    process.env.PATH = previous;
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const headers = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
  const info = () => app.inject({ url: `${base}/file-info`, headers });
  const action = (name: 'open' | 'reveal') =>
    app.inject({ method: 'POST', url: `${base}/${name}`, headers, payload: {} });
  async function target() {
    const response = await info();
    assert.equal(response.statusCode, 200, response.body);
    const metadata = response.json();
    assert.equal(metadata.local, true);
    if (process.platform === 'darwin') {
      for (const name of ['open', 'reveal'] as const) {
        await rm(log, { force: true });
        const response = await action(name);
        assert.equal(response.statusCode, 200, response.body);
        const argv = (await readFile(log, 'utf8')).trim().split('\n');
        assert.equal(argv.at(-1), metadata.path, 'menu/open/reveal resolve the same current version');
      }
    }
    return metadata as { path: string; filename: string; mime: string; displayPath: string };
  }
  return { app, base, headers, info, action, target };
}
