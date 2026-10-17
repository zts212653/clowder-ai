import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

for (const alias of [false, true])
  test(`desktop API bundle keeps module URLs and workers after moving (alias=${alias})`, async () => {
    const { bundleDesktopApi } = await import('./scripts/bundle-desktop-api.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bundle-'));
    try {
      const dist = path.join(root, 'api/dist');
      fs.mkdirSync(path.join(dist, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(root, 'api/package.json'), '{"type":"module"}');
      fs.writeFileSync(path.join(dist, 'nested/asset.json'), '{"witness":7}');
      fs.writeFileSync(
        path.join(dist, 'nested/worker.mjs'),
        "import {parentPort} from 'node:worker_threads'; parentPort.postMessage(9);",
      );
      fs.writeFileSync(
        path.join(dist, 'nested/part.js'),
        `import fs from 'node:fs'; import {Worker} from 'node:worker_threads'; export const result=JSON.parse(fs.readFileSync(new URL('./asset.json', import.meta.url))).witness;
       export const worker = () => new Promise((resolve,reject)=>{const w=new Worker(new URL('./worker.mjs',import.meta.url)); w.once('message',resolve);w.once('error',reject);});`,
      );
      fs.writeFileSync(
        path.join(dist, 'index.js'),
        `const part=await import('./nested/part.js'); console.log(JSON.stringify({value:part.result, worker:await part.worker(), url:import.meta.url}));`,
      );
      const api = path.join(root, 'api');
      const input = alias ? path.join(root, 'aliased-api') : api;
      if (alias) fs.symlinkSync(fs.realpathSync(api), input, process.platform === 'win32' ? 'junction' : 'dir');
      await bundleDesktopApi(input);
      const moved = path.join(root, 'moved');
      fs.renameSync(path.join(root, 'api'), moved);
      const result = JSON.parse(
        execFileSync(process.execPath, [path.join(moved, 'dist/index.desktop.js')], { encoding: 'utf8' }),
      );
      assert.equal(result.value, 7);
      assert.equal(result.worker, 9);
      const original = JSON.parse(
        execFileSync(process.execPath, [path.join(moved, 'dist/index.js')], { encoding: 'utf8' }),
      );
      assert.deepEqual(result, original);
      assert.ok(fs.existsSync(path.join(moved, 'dist/nested/part.js')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
