import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { fixture } from './lib/worktree-finish-fixture.mjs';

it('refuses an open data file even when its consumer cwd and argv are outside the checkout', async () => {
  const fx = fixture();
  let child;
  try {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe'));
    const original = join(path, '.cat-cafe/data.json');
    writeFileSync(original, '{"original":true}\n');
    child = spawn(
      process.execPath,
      [
        '-e',
        'require("node:fs").openSync(process.env.FINISH_DATA_PATH,"a"); process.stdout.write("ready"); setInterval(()=>{},1000);',
      ],
      { cwd: fx.repo, env: { ...process.env, FINISH_DATA_PATH: original }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(child.stdout, 'data');
    assert.throws(() => fx.finish(path, { cwdProbe: undefined }), /busy.*open-file/);
    assert.equal(readFileSync(original, 'utf8'), '{"original":true}\n');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});
