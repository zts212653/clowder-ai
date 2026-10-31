import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const provenanceDirectory = '/tmp/f326-b-movie-provenance';
const fixturePath = path.join(repository, 'packages/api/test/fixtures/video-project/ep0.json');
const jsonFile = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
function isolatedOrigin(value, port) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1', 'Keep browser and API session cookies on the same direct loopback hostname');
  assert.equal(url.port, String(port), 'Only the explicitly assigned feature environment is admissible');
  return url.origin;
}
export async function createScreeningJourney() {
  assert.equal(
    process.env.F326_BROWSER_ALLOW_MUTATIONS,
    'isolated-feature',
    'Explicitly admit writes to the root-managed feature environment; runtime/Alpha are outside this harness',
  );
  const webOrigin = isolatedOrigin(process.env.F326_BROWSER_WEB_URL ?? 'http://127.0.0.1:3161', 3161);
  const apiOrigin = isolatedOrigin(process.env.F326_BROWSER_API_URL ?? 'http://127.0.0.1:3162', 3162);
  const evidence = process.env.F326_BROWSER_EVIDENCE_DIR ?? (await mkdtemp('/tmp/f326-browser-journey-'));
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
  let csrfToken, userId;
  try {
    const session = await context.request.get(`${apiOrigin}/api/session`);
    assert.equal(session.status(), 200, 'Root must finish canonical build and start the isolated API before this test');
    ({ csrfToken, userId } = await session.json());
  } catch (error) {
    await browser.close();
    throw error;
  }
  assert.ok(csrfToken && userId, 'Authentication comes from the real server-issued browser session');
  const calls = [],
    errors = [],
    requests = [],
    ranges = [];
  const request = async (route, data) => {
    const response =
      data === undefined
        ? await context.request.get(`${apiOrigin}${route}`)
        : await context.request.post(`${apiOrigin}${route}`, { data, headers: { 'x-csrf-token': csrfToken } });
    const text = await response.text();
    calls.push({ route, method: data === undefined ? 'GET' : 'POST', status: response.status() });
    assert.ok(response.ok(), `${route}: ${response.status()} ${text.slice(0, 2000)}`);
    return JSON.parse(text);
  };
  const page = await context.newPage().catch(async (error) => {
    await browser.close();
    throw error;
  });
  page.setDefaultTimeout(45000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (incoming) => {
    if (incoming.url().startsWith(apiOrigin) && incoming.method() === 'POST') {
      const body = incoming.postData() ?? '';
      requests.push({
        url: incoming.url(),
        bodyPreview: body.slice(0, 1024),
        bodyBytes: Buffer.byteLength(body),
        bodyDigest: createHash('sha256').update(body).digest('hex'),
      });
    }
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/media'))
      ranges.push({
        status: response.status(),
        range: response.headers()['content-range'] ?? null,
        requestRange: response.request().headers().range ?? null,
      });
  });
  return {
    browser,
    context,
    page,
    webOrigin,
    apiOrigin,
    evidence,
    request,
    calls,
    errors,
    requests,
    ranges,
    userId,
    async close() {
      await browser.close();
    },
  };
}
async function bindRoot(journey, name, rootPath) {
  const canonical = await realpath(rootPath);
  const { worktrees } = await journey.request('/api/workspace/worktrees');
  const existing = worktrees.find((entry) => entry.resolvedRoot === canonical || entry.root === canonical);
  if (existing?.id?.startsWith('f063_root_v1_')) return existing;
  const { linked } = await journey.request('/api/workspace/linked-roots', { name, path: canonical });
  assert.ok(linked.id.startsWith('f063_root_v1_'), 'Use the admitted durable root ID, not a display alias');
  await journey.request('/api/workspace/worktrees');
  return { ...linked, root: canonical };
}
export async function prepareScreeningJourney(journey) {
  const provenance = await jsonFile(path.join(provenanceDirectory, 'provenance-summary.json'));
  const candidates = await jsonFile(path.join(provenanceDirectory, 'candidate-probes.json'));
  const movieFor = (filename) => {
    const result = candidates.find((candidate) => path.basename(candidate.path) === filename);
    assert.ok(result, `Missing read-only provenance candidate ${filename}`);
    return result;
  };
  const movies = [movieFor(provenance.recommendedPair.left), movieFor(provenance.recommendedPair.right)];
  for (const movie of movies) assert.equal(await fileDigest(movie.path), `sha256:${movie.sha256}`);
  const roots = {
    'cucu-character-references': await bindRoot(
      journey,
      'f326-character-references',
      '/home/user/cat-cafe-shared/references/characters',
    ),
    'remotion-studio': await bindRoot(journey, 'f326-remotion-studio', '/home/user/projects/remotion-studio'),
    'ep0-artworks': await bindRoot(
      journey,
      'f326-ep0-artworks',
      '/home/user/cat-cafe-artworks/2026-10-04-ep0-cucu/final-v2',
    ),
  };
  const movieRoot = await bindRoot(journey, 'f326-existing-movies', path.dirname(movies[0].path));
  const document = await jsonFile(fixturePath);
  const originalFixtureDigest = await fileDigest(fixturePath);
  document.title = `F326 真实审片 ${Date.now()}`;
  document.origin.refs.push(
    `browser-import:${fixturePath}@${originalFixtureDigest}`,
    ...provenance.originalProducerEvidence.map((ref) => `message:${ref}`),
  );
  for (const version of document.assets.flatMap((asset) => asset.versions)) {
    if (version.locator.kind !== 'workspace') continue;
    const original = version.locator.rootId;
    assert.ok(roots[original], `Unadmitted sampled asset root ${original}`);
    version.locator.rootId = roots[original].id;
  }
  const thread = await journey.request('/api/threads', {
    title: document.title,
    projectPath: repository,
    idempotencyKey: randomUUID(),
  });
  assert.ok(thread?.id, 'Thread comes from ordinary admission, not a hidden seeded URL');
  await journey.page.goto(`${journey.webOrigin}/thread/${thread.id}`, { waitUntil: 'domcontentloaded' });
  await ensureWorkspaceOpen(journey.page, { readinessTimeoutMs: 90000 });
  const home = journey.page.getByRole('region', { name: '片子', exact: true });
  await home.waitFor();
  const imported = journey.page.waitForResponse(
    (response) =>
      response.url() === `${journey.apiOrigin}/api/video-projects` && response.request().method() === 'POST',
  );
  await home.getByLabel('项目文件', { exact: true }).setInputFiles({
    name: 'ep0-generic-sampled-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });
  const importResponse = await imported;
  assert.ok(importResponse.ok(), await importResponse.text());
  const receipt = await importResponse.json();
  const frozen = await journey.request(`/api/video-projects/${encodeURIComponent(receipt.contentRef)}`);
  const descriptors = [];
  for (const [index, movie] of movies.entries()) {
    const source = await journey.request('/api/video-projects/media-source', {
      locator: { worktreeId: movieRoot.id, path: path.basename(movie.path) },
    });
    assert.equal(source.revision, `sha256:${movie.sha256}`);
    const head = await journey.request(`/api/video-projects/${encodeURIComponent(frozen.contentRef)}`);
    const id = randomUUID();
    const result = await journey.request(`/api/video-projects/${encodeURIComponent(frozen.contentRef)}/screenings`, {
      expectedOwnerRevision: head.ownerRevision,
      operationId: randomUUID(),
      id,
      title: index ? '清洁主片＋片尾' : '精绘动效预览',
      input: { contentRef: frozen.contentRef, ownerRevision: frozen.ownerRevision, blobDigest: frozen.blobDigest },
      source: { locator: source.locator, expectedSourceRevision: source.revision },
      mapping: {
        segments: provenance.registrationMapping.segments.map((segment) => ({
          ...segment,
          refs: provenance.originalProducerEvidence,
        })),
        frame: {
          displayWidth: source.media.width,
          displayHeight: source.media.height,
          canvasWidth: document.timeline.width,
          canvasHeight: document.timeline.height,
          rotation: 0,
        },
      },
      refs: provenance.originalProducerEvidence,
    });
    assert.equal(result.screening.id, id);
    descriptors.push(
      await journey.request(
        `/api/video-projects/${encodeURIComponent(frozen.contentRef)}/screenings/${encodeURIComponent(id)}`,
      ),
    );
  }
  const manifest = {
    threadId: thread.id,
    contentRef: frozen.contentRef,
    title: document.title,
    input: { contentRef: frozen.contentRef, ownerRevision: frozen.ownerRevision, blobDigest: frozen.blobDigest },
    descriptors,
    roots,
    movieRoot,
    movies: movies.map(({ path: filename, sha256, bytes }) => ({ filename, sha256, bytes })),
    originalFixtureDigest,
    provenance,
    sourceAnnotation: 'Frozen real-sample JSON imported formally; only directory IDs/title/trace refs rebound',
  };
  await writeFile(path.join(journey.evidence, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
export async function openPreparedProject(journey, manifest) {
  await journey.page.goto(`${journey.webOrigin}/thread/${manifest.threadId}`, { waitUntil: 'domcontentloaded' });
  await ensureWorkspaceOpen(journey.page, { readinessTimeoutMs: 90000 });
  const surface = journey.page.locator(`[data-video-project="${manifest.contentRef}"]`);
  const project = journey.page
    .getByRole('region', { name: /^(片子|Films)$/, exact: true })
    .getByRole('button', { name: new RegExp(manifest.title) });
  const entry = await Promise.race([
    surface.waitFor({ state: 'visible' }).then(() => 'retained-surface'),
    project.waitFor({ state: 'visible' }).then(() => 'workspace-home'),
  ]);
  if (entry === 'workspace-home') await project.click();
  await surface.waitFor({ state: 'visible' });
  return entry;
}
export async function decodedSeek(video, seconds) {
  return video.evaluate(
    (element, position) =>
      new Promise((resolve, reject) => {
        let decoded;
        const observed = [];
        const finish = () => {
          if (!decoded || element.seeking) return;
          clearTimeout(timeout);
          element.removeEventListener('seeked', finish);
          resolve({ ...decoded, currentTime: element.currentTime, seeking: element.seeking });
        };
        const timeout = setTimeout(() => {
          element.removeEventListener('seeked', finish);
          reject(
            new Error(
              `No decoded frame at ${position}s: ${JSON.stringify({ observed, currentTime: element.currentTime, readyState: element.readyState, seeking: element.seeking, error: element.error?.message })}`,
            ),
          );
        }, 45000);
        const capture = (_now, metadata) => {
          observed.push({ mediaTime: metadata.mediaTime, seeking: element.seeking, currentTime: element.currentTime });
          if (Math.abs(metadata.mediaTime - position) > 1 / 30 + 0.002)
            return element.requestVideoFrameCallback(capture);
          // Chromium may present a paused seek's only frame before the queued seeked event.
          // Retain the decoder evidence, then require actual seek completion independently.
          decoded = {
            mediaTime: metadata.mediaTime,
            readyState: element.readyState,
            duration: element.duration,
          };
          finish();
        };
        element.pause();
        element.addEventListener('seeked', finish);
        element.requestVideoFrameCallback(capture);
        element.currentTime = position;
      }),
    seconds,
  );
}
/** Pointer interaction with Chromium's actual UA timeline, not fake events or inferred media progress. */
export async function nativeScrub(journey, fraction) {
  const cdp = await journey.context.newCDPSession(journey.page);
  try {
    await cdp.send('DOM.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node) => {
      const attributes = Object.fromEntries(
        Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, index) => [
          node.attributes[index * 2],
          node.attributes[index * 2 + 1],
        ]),
      );
      if (node.nodeName === 'INPUT' && attributes.type === 'range' && /timeline|seek/i.test(JSON.stringify(attributes)))
        return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const result = find(child);
        if (result) return result;
      }
      return null;
    };
    const timeline = find(root);
    assert.ok(
      timeline,
      'Native Chromium seek control must be discoverable; no programmatic fallback masquerades as a drag',
    );
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: timeline.nodeId });
    const [left, top, right, , , bottom] = model.content;
    const y = (top + bottom) / 2,
      x = left + (right - left) * fraction;
    await journey.page.mouse.move(left + (right - left) * 0.1, y);
    await journey.page.mouse.down();
    await journey.page.mouse.move(x, y, { steps: 15 });
    await journey.page.mouse.up();
  } finally {
    await cdp.detach();
  }
}
