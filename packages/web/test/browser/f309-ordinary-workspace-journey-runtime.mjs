import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  findFreePort,
  NEXT_BIN,
  readProductionBuildId,
  stopServer,
  THREAD_ID,
  WEB_ROOT,
  waitForPage,
} from './f309-ordinary-workspace-journey-fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

export async function startF309OrdinaryWorkspaceJourney({ apiUrl = '' } = {}) {
  const sync = spawnSync(process.execPath, [path.resolve(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  const productionBuildId = await readProductionBuildId();
  const environment = await createNextDevTestEnvironment('f309-ordinary', {
    NEXT_PUBLIC_API_URL: apiUrl,
    // The document's runtime API identity takes precedence over NEXT_PUBLIC_API_URL.
    ...(apiUrl ? { API_SERVER_PORT: new URL(apiUrl).port } : {}),
    CAT_CAFE_DEPLOYMENT_ID: 'feature-test',
  });
  const port = await findFreePort();
  const output = [];
  const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: environment.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}/thread/${THREAD_ID}`;
  await waitForPage(baseUrl, server, output);
  const browser = await chromium.launch({ headless: true });
  return { browser, baseUrl, productionBuildId, server, environment };
}

export async function stopF309OrdinaryWorkspaceJourney(suite) {
  await suite?.browser?.close();
  await stopServer(suite?.server);
  await suite?.environment.cleanup();
  if (suite?.productionBuildId !== null)
    assert.equal(
      await readProductionBuildId(),
      suite.productionBuildId,
      'F309 browser journey must preserve .next/BUILD_ID',
    );
}
