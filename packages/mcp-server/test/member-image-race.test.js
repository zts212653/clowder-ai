import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMemberImage } from '../src/tools/member-image-tools.js';

test(
  'atomic swap-and-restore pressure never returns bytes outside the allowed roots',
  {
    skip: !['darwin', 'linux'].includes(process.platform),
    timeout: 15_000,
  },
  async (t) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'member-image-race-')));
    const root = join(dir, 'allowed');
    const outside = join(dir, 'outside');
    const parent = join(root, 'swap');
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    const allowedBytes = Buffer.from('allowed fixture image bytes');
    const outsideBytes = Buffer.from('outside fixture image bytes');
    await writeFile(join(parent, 'pic.png'), allowedBytes);
    await writeFile(join(outside, 'pic.png'), outsideBytes);
    await symlink(outside, join(root, 'swap-other'));
    const previous = process.env.ALLOWED_WORKSPACE_DIRS;
    process.env.ALLOWED_WORKSPACE_DIRS = root;
    t.after(async () => {
      if (previous === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = previous;
      await rm(dir, { recursive: true, force: true });
    });
    assert.deepEqual((await readMemberImage(join(parent, 'pic.png'))).bytes, allowedBytes);
    const swapper = spawn(
      'python3',
      [fileURLToPath(new URL('./helpers/member-image-swapper.py', import.meta.url)), parent, join(root, 'swap-other')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const ended = once(swapper, 'close');
    t.after(async () => {
      if (swapper.exitCode === null && swapper.signalCode === null) swapper.kill('SIGTERM');
      await ended;
    });
    let output = '';
    let errors = '';
    swapper.stdout.on('data', (chunk) => {
      output += chunk;
    });
    swapper.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    await once(swapper.stdout, 'data');
    assert.match(output, /ready/);
    const counts = { calls: 0, allowed: 0, outside: 0, rejected: 0 };
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      counts.calls += 1;
      let image;
      try {
        image = await readMemberImage(join(parent, 'pic.png'));
      } catch {
        counts.rejected += 1;
        continue;
      }
      if (image.bytes.equals(outsideBytes)) counts.outside += 1;
      else {
        assert.deepEqual(image.bytes, allowedBytes);
        counts.allowed += 1;
      }
    }
    const [code, signal] = await ended;
    assert.equal(code, 0, errors);
    assert.equal(signal, null);
    const activity = JSON.parse(output.trim().split('\n').at(-1));
    assert.ok(activity.swaps > 0);
    console.log(JSON.stringify({ ...counts, swaps: activity.swaps, platform: process.platform }));
    assert.ok(counts.calls > 0);
    assert.equal(counts.outside, 0, 'forbidden bytes escaped during directory exchange');
  },
);
