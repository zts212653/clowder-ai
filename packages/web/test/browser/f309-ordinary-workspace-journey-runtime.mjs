import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import {
  findFreePort,
  NEXT_BIN,
  readProductionBuildId,
  stopServer,
  THREAD_ID,
  WEB_ROOT,
  waitForPage,
} from './f309-ordinary-workspace-journey-fixture.mjs';

export async function startF309OrdinaryWorkspaceJourney() {
  const sync = spawnSync(process.execPath, [path.resolve(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  const productionBuildId = await readProductionBuildId();
  const testDistDirPath = await mkdtemp(path.join(WEB_ROOT, '.next-test-f309-ordinary-'));
  const testDistDir = path.basename(testDistDirPath);
  const testTsconfigPath = path.join(WEB_ROOT, `tsconfig.${testDistDir.slice(1)}.json`);
  await writeFile(
    testTsconfigPath,
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { noEmit: true },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${testDistDir}/types/**/*.ts`],
        exclude: ['node_modules'],
      },
      null,
      2,
    )}\n`,
  );
  const port = await findFreePort();
  const output = [];
  const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: '',
      CAT_CAFE_DEPLOYMENT_ID: 'feature-test',
      CAT_CAFE_WEB_TEST_DIST_DIR: testDistDir,
      CAT_CAFE_WEB_TEST_TSCONFIG: path.basename(testTsconfigPath),
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}/thread/${THREAD_ID}`;
  await waitForPage(baseUrl, server, output);
  const browser = await chromium.launch({ headless: true });
  return { browser, baseUrl, productionBuildId, server, testDistDirPath, testTsconfigPath };
}

export async function stopF309OrdinaryWorkspaceJourney(suite) {
  await suite?.browser?.close();
  await stopServer(suite?.server);
  if (suite?.testDistDirPath) await rm(suite.testDistDirPath, { recursive: true, force: true });
  if (suite?.testTsconfigPath) await rm(suite.testTsconfigPath, { force: true });
  if (suite?.productionBuildId !== null)
    assert.equal(
      await readProductionBuildId(),
      suite.productionBuildId,
      'F309 browser journey must preserve .next/BUILD_ID',
    );
}
