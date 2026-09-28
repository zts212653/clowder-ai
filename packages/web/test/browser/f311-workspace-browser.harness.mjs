import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { availablePort, stopChild } from './f290-runtime-journey.harness.mjs';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
export const CONTRACT_THREAD_ID = 'thread-f311-workspace-contract';

async function resolvePreparationMedia({ url, programPath, projection, ownerBindings, preparationMediaAvailable }) {
  const sha256 = url.pathname.slice(`${programPath}/preparation-media/`.length);
  const programRef = { ownerFeatureId: 'F311', ownerStateRef: projection.program.programId };
  const publication = await ownerBindings.preparationReview({ programRef, objectRef: projection.program.objectRef });
  const media =
    publication.status === 'resolved'
      ? publication.groups
          .flatMap((group) => group.items)
          .flatMap((item) => item.resources)
          .find((resource) => resource.media?.mediaRef.version === sha256)?.media
      : undefined;
  if (!media) return { status: 404, body: { error: 'not_found' } };
  if (!preparationMediaAvailable()) return { status: 503, body: { error: 'fixture_media_unavailable' } };
  const result = await ownerBindings.preparationMedia({
    programRef,
    objectRef: projection.program.objectRef,
    mediaRef: media.mediaRef,
  });
  return result.status === 'resolved'
    ? { body: Buffer.from(result.bytes), contentType: result.contentType, binary: true }
    : { status: 422, body: result };
}

async function waitForShell(url, child, output) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`F311 Next exited before readiness:\n${output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // The isolated real Thread route is starting or compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`F311 Thread route did not become ready:\n${output()}`);
}

async function resolveProgramRead({
  url,
  programPath,
  projection,
  ownerBindings,
  programReads,
  preparationMediaAvailable,
}) {
  const programRef = { ownerFeatureId: 'F311', ownerStateRef: projection.program.programId };
  if (url.pathname === `${programPath}/preparation-review` && ownerBindings)
    return {
      body: await ownerBindings.preparationReview({ programRef, objectRef: projection.program.objectRef }),
    };
  if (url.pathname === `${programPath}/asset-review` && ownerBindings) {
    const selected = url.searchParams.get('selectedVersionRef');
    return {
      body: await ownerBindings.versionReview({
        programRef,
        objectRef: projection.program.objectRef,
        ...(selected ? { selectedVersionRef: JSON.parse(selected) } : {}),
      }),
    };
  }
  if (url.pathname === `${programPath}/exploration` && ownerBindings) {
    const selection = {};
    for (const key of ['selectedNodeRef', 'selectedExperimentRef', 'comparisonExperimentRef']) {
      const value = url.searchParams.get(key);
      if (value) selection[key] = JSON.parse(value);
    }
    return {
      body: await ownerBindings.explorationReview({
        programRef,
        objectRef: projection.program.objectRef,
        ...selection,
      }),
    };
  }
  if (url.pathname.startsWith(`${programPath}/preparation-media/`) && ownerBindings) {
    return resolvePreparationMedia({ url, programPath, projection, ownerBindings, preparationMediaAvailable });
  }
  return programReads.has(url.pathname)
    ? { body: programReads.get(url.pathname) }
    : { status: 404, body: { error: 'unknown_program_read' } };
}

async function resolveFixtureRead({
  request,
  url,
  programPath,
  projection,
  ownerBindings,
  programReads,
  preparationMediaAvailable,
  thread,
}) {
  if (url.pathname.startsWith('/api/capability-evolution/programs'))
    return resolveProgramRead({
      url,
      programPath,
      projection,
      ownerBindings,
      programReads,
      preparationMediaAvailable,
    });
  if (url.pathname === '/api/session') return { body: { userId: 'default-user' } };
  if (url.pathname === '/api/threads') return { body: { threads: [thread] } };
  if (url.pathname === `/api/threads/${CONTRACT_THREAD_ID}`) return { body: thread };
  return realSurfaceApiResponse({ url: () => url.href, method: () => request.method }, false);
}

function rejectProgramWrite(request, url, programWrites) {
  programWrites.push({ method: request.method, path: url.pathname });
  return { status: 405, body: { error: 'read_only_contract_fixture' } };
}

function createFixtureApi({
  programPath,
  projection,
  ownerBindings,
  programReads,
  programWrites,
  preparationMediaAvailable,
  thread,
  handleRequest,
}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      const custom = await handleRequest?.({ request, url });
      const result =
        custom ??
        (url.pathname.startsWith('/api/capability-evolution/programs') && request.method !== 'GET'
          ? rejectProgramWrite(request, url, programWrites)
          : await resolveFixtureRead({
              request,
              url,
              programPath,
              projection,
              ownerBindings,
              programReads,
              preparationMediaAvailable,
              thread,
            }));
      response.writeHead(result.status ?? 200, {
        'cache-control': 'private, no-store',
        'content-type': result.contentType ?? 'application/json',
      });
      response.end(result.binary ? result.body : JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: 'fixture_owner_read_failed',
          detail: error instanceof Error ? error.message : 'unknown error',
        }),
      );
    }
  });
}

/** Synthetic owner reads in the production shell; never borrows Alpha or a live Café. */
export async function startEvolutionWorkspaceBrowserFixture(projection, options = {}) {
  const thread = { id: CONTRACT_THREAD_ID, title: 'F311 Workspace contract fixture', projectPath: '/project/cat-cafe' };
  const programPath = `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}`;
  let ownerBindings;
  let latestPreparationPublished = false;
  let mediaAvailable = true;
  if (
    projection.program.objectRef.ownerFeatureId === 'microduck-owner' &&
    projection.program.objectRef.ownerStateRef === 'simulator:walking'
  ) {
    const ownerModule = await import(
      pathToFileURL(
        path.resolve(
          REPO_ROOT,
          'packages/api/src/infrastructure/capability-evolution/adapters/microduck-local-owner.ts',
        ),
      ).href
    );
    ownerBindings = ownerModule.createMicroduckLocalOwnerBindings({
      repoRoot: REPO_ROOT,
      now: () => '2026-09-08T00:00:00.000Z',
      readBytes: async (absolutePath) => {
        const bytes = await readFile(absolutePath);
        if (!absolutePath.endsWith('/pipeline/football/workspace-publication.json') || latestPreparationPublished)
          return bytes;
        const publication = JSON.parse(bytes.toString('utf8'));
        publication.resourceCommit = '1d9ba1cb187974e2dfa31c99ea4c758af89da67b';
        publication.updatedAt = '2026-09-07T19:20:00.000Z';
        for (const item of publication.groups.flatMap((group) => group.items)) {
          if (item.activity) item.activity.updatedAt = publication.updatedAt;
          if (item.title === 'v3 · 前进弧线路径') {
            item.activity.state = 'running';
            item.activity.detail = 'v3 公开运行仍在进行；尚无完成结果。';
          }
        }
        publication.groups[0].items = publication.groups[0].items.filter(
          (item) =>
            item.title !== 'v3 时间补充 · 同一控制器的 26 秒条件' && item.title !== 'v4 · 缩短弧线，右侧踢中、左侧踢空',
        );
        return Buffer.from(JSON.stringify(publication));
      },
    });
  }
  const programReads = new Map([
    ['/api/capability-evolution/programs', { programs: [projection] }],
    [programPath, projection],
    [
      `${programPath}/asset-review`,
      {
        schemaVersion: 1,
        status: 'unavailable',
        programRef: { ownerFeatureId: 'F311', ownerStateRef: projection.program.programId },
        objectRef: projection.program.objectRef,
        blockers: [{ code: 'version_review_unavailable', ownerRef: projection.program.objectRef }],
      },
    ],
  ]);
  const programWrites = [];
  const api = createFixtureApi({
    programPath,
    projection,
    ownerBindings,
    programReads,
    programWrites,
    preparationMediaAvailable: () => mediaAvailable,
    thread,
    handleRequest: options.handleRequest,
  });
  let nextDev;
  let web;
  const close = async () => {
    try {
      if (web) await stopChild(web);
    } finally {
      api.closeAllConnections();
      if (api.listening) await new Promise((resolve) => api.close(resolve));
      await nextDev?.cleanup();
    }
  };
  try {
    const sync = spawnSync(process.execPath, [path.join(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
      cwd: WEB_ROOT,
      encoding: 'utf8',
    });
    assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
    api.listen(options.apiPort ?? 0, '127.0.0.1');
    await once(api, 'listening');
    const apiUrl = `http://127.0.0.1:${api.address().port}`;
    const webUrl = `http://127.0.0.1:${options.webPort ?? (await availablePort())}`;
    nextDev = await createNextDevTestEnvironment('f311-workspace', {
      NEXT_PUBLIC_API_URL: webUrl,
      API_SERVER_PORT: new URL(apiUrl).port,
      CAT_CAFE_DEPLOYMENT_ID: 'feature-test',
    });
    let output = '';
    web = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', new URL(webUrl).port], {
      cwd: WEB_ROOT,
      env: nextDev.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [web.stdout, web.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-8_000);
      });
    }
    await once(web, 'spawn');
    await waitForShell(`${webUrl}/thread/${CONTRACT_THREAD_ID}`, web, () => output);
    return {
      webUrl,
      apiUrl,
      programWrites,
      publishLatestPreparation: () => {
        latestPreparationPublished = true;
      },
      setPreparationMediaAvailable: (value) => {
        mediaAvailable = value;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
