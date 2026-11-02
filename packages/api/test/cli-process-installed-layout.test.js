import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundleDesktopApi } from '../../../desktop/scripts/bundle-desktop-api.mjs';
import { exportFrozenRuntime } from '../../../desktop/scripts/frozen-runtime-export.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceApi = path.join(repository, 'packages/api');
const ts = createRequire(path.join(sourceApi, 'package.json'))('typescript');
const ownerId = '12345678-1234-4234-8234-123456789abc';

for (const sharedDependencies of [false, true]) {
  test(`installed process observation survives API bundling and relocation (shared=${sharedDependencies})`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-process-observation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const api = path.join(workspace, 'packages/api');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(api, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(api, 'dist/utils'), { recursive: true });
    fs.copyFileSync(path.join(sourceApi, 'package.json'), path.join(api, 'package.json'));
    // Use the production reader and its actual package assets, not a reader mock.
    for (const name of ['cli-process-ownership', 'cli-process-environment']) {
      const source = path.join(sourceApi, `src/utils/${name}.ts`);
      const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
        fileName: source,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      fs.writeFileSync(path.join(api, `dist/utils/${name}.js`), compiled.outputText);
    }
    if (fs.existsSync(path.join(sourceApi, 'runtime'))) {
      fs.cpSync(path.join(sourceApi, 'runtime'), path.join(api, 'runtime'), { recursive: true });
    }
    fs.writeFileSync(
      path.join(api, 'dist/index.js'),
      `import assert from 'node:assert/strict';
      import {readUnixProcessSnapshot,readUnixProcessSnapshotSync,CLI_PROCESS_OWNER_ENV,CLI_PROCESS_SNAPSHOT_TIMEOUT_MS}
        from './utils/cli-process-ownership.js';
      const result={loaded:true,workerExecuted:false,deadline:CLI_PROCESS_SNAPSHOT_TIMEOUT_MS};
      if(process.platform==='darwin') {
        const marker=CLI_PROCESS_OWNER_ENV+'='+process.env[CLI_PROCESS_OWNER_ENV];
        const options={includeEnvironment:true,pids:[process.pid],environmentMarkers:[marker]};
        for(const snapshot of [readUnixProcessSnapshotSync(options),await readUnixProcessSnapshot(options)]) {
          assert.equal(snapshot?.get(process.pid)?.pid,process.pid);
          assert.ok(snapshot.get(process.pid).commandAndEnvironment.includes(marker));
        }
        result.workerExecuted=true;
      }
      console.log(JSON.stringify(result));`,
    );
    const lock = path.join(workspace, 'pnpm-lock.yaml');
    fs.writeFileSync(lock, 'lockfileVersion: 9\n');
    const exported = path.join(root, 'exported');
    exportFrozenRuntime(workspace, exported, ['api'], lock, { sharedDependencies });
    await bundleDesktopApi(path.join(exported, 'api'));
    const installed = path.join(root, 'installed elsewhere');
    fs.renameSync(exported, installed);
    fs.rmSync(workspace, { recursive: true, force: true });
    const execute = (entry) =>
      JSON.parse(
        execFileSync(process.execPath, [path.join(installed, 'api/dist', entry)], {
          cwd: installed,
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
          env: { ...process.env, CAT_CAFE_PROCESS_OWNER_ID: ownerId },
        }),
      );
    const expected = { loaded: true, workerExecuted: process.platform === 'darwin', deadline: 2000 };
    assert.deepEqual(execute('index.js'), expected);
    assert.deepEqual(execute('index.desktop.js'), expected);
  });
}
