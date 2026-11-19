import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const [moduleFile, artifactDirectory, hostResolver] = process.argv.slice(2);
assert.ok(moduleFile && artifactDirectory, 'Usage: node feedback-diagnostic-worker-proof.mjs <packed diagnostic-environment.js> <artifact directory> [desktop/project-root.js]');
await mkdir(resolve(artifactDirectory), { recursive: true });
const proofRoot = await mkdtemp(join(resolve(artifactDirectory), 'worker-fixture-'));
const macLayout = Boolean(hostResolver);
const root = macLayout ? resolve(proofRoot, 'Clowder AI.app/Contents/Resources') : resolve(proofRoot);
const workerDir = join(root, 'packages/api/dist/domains/plugin/execution-worker');
const resources = macLayout ? root : join(root, 'desktop-dist/resources');
const logDirectory = join(root, 'user-state/data/logs/api');
const project = join(root, 'user-state/project');
await Promise.all([workerDir, resources, logDirectory, project].map(p => mkdir(p,{recursive:true})));
await writeFile(join(resources, 'app.asar'), '');
if (macLayout) {
  await mkdir(join(root, 'packages/api/node_modules'));
  await writeFile(join(root, 'packages/api/dist/index.js'), '');
  const { resolveProjectRootFromDir } = createRequire(import.meta.url)(resolve(hostResolver));
  assert.equal(resolveProjectRootFromDir(join(root, 'app.asar')), root);
}
const entry = join(workerDir, 'bootstrap.js');
await writeFile(entry, `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.moduleUrl).then(({ diagnosticEnvironment }) => diagnosticEnvironment(workerData.env, workerData.project))
    .then(async diagnostic => parentPort.postMessage({ usesWorkerEntry: process.argv[1] === __filename,
      facts: diagnostic.facts, desktopGuide: (await diagnostic.guide()).includes('# 桌面部署'),
      desktopLogRoot: diagnostic.desktopLogRoot === require('node:path').dirname(workerData.env.logDirectory) }));
`);
const worker = new Worker(entry, {
  execArgv: [],
  env: { ...process.env, CAT_CAFE_DESKTOP_STARTUP_ID: 'synthetic-id', CAT_CAFE_RUNTIME_ROOT: root },
  workerData: { moduleUrl: pathToFileURL(resolve(moduleFile)).href, project,
    env: { version: 'synthetic', platform: macLayout ? 'darwin' : 'win32', architecture: macLayout ? 'arm64' : 'x64',
      nodeVersion: process.versions.node, projectRoot: project, logDirectory } },
});
const result = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', code => { if (code) reject(new Error(`Worker exit ${code}`)); });
});
console.log(JSON.stringify({ ...result, hostMacResourcesLayout: macLayout, nativeMac: false }, null, 2));
assert.equal(result.usesWorkerEntry, true);
if (macLayout) assert.match(result.facts, /macOS.*darwin.*arm64/);
assert.match(result.facts, /桌面安装版/);
assert.match(result.facts, /所选项目未发现 Clowder 源码/);
assert.equal(result.desktopGuide, true);
assert.equal(result.desktopLogRoot, true);
