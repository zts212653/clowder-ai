import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('frozen production install receives the tracked patches referenced by its lockfile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-patches-'));
  const source = path.join(root, 'source');
  const bin = path.join(root, 'bin');
  const write = (relative, content) => {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  try {
    write('package.json', JSON.stringify({ pnpm: { patchedDependencies: { 'fixture@1.0.0': 'patches/fix.patch' } } }));
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write('pnpm-lock.yaml', 'patchedDependencies:\n  fixture@1.0.0:\n    path: patches/fix.patch\n');
    write('.npmrc', '');
    write('tsconfig.base.json', '{}');
    write('packages/api/package.json', '{"name":"fixture-api"}');
    write('patches/fix.patch', 'reviewed dependency patch\n');
    write('.build-input-files.json', JSON.stringify(['packages/api/package.json', 'patches/fix.patch']));
    fs.mkdirSync(bin);
    const probe = path.join(root, 'install-probe.cjs');
    fs.writeFileSync(
      probe,
      `
      const fs = require('node:fs');
      const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      const patch = manifest.pnpm.patchedDependencies['fixture@1.0.0'];
      if (fs.readFileSync(patch, 'utf8') !== 'reviewed dependency patch\\n') process.exit(78);
      console.log('PATCH_INPUT_READY');
      process.exit(79);
    `,
    );
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const shim = path.join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    fs.writeFileSync(
      shim,
      process.platform === 'win32'
        ? `@"${process.execPath}" "${probe}"\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(probe)}\n`,
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./scripts/frozen-runtime-deploy.mjs', import.meta.url)), source, path.join(root, 'out')],
      { env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.error, undefined);
    // The stub ends at the actual install boundary; no package install or release is performed.
    assert.match(result.stdout, /PATCH_INPUT_READY/, result.stderr);
    assert.match(result.stderr, /Frozen production install failed \(79\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
