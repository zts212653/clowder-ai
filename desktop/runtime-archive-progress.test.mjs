import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRuntimeArchive } from './scripts/create-runtime-archive.mjs';
import { resolveNpmCli } from './scripts/rebuild-frozen-dependencies.mjs';

const { extractRuntimeArchive } = createRequire(import.meta.url)('./scripts/extract-runtime-archive.cjs');
const tar = createRequire(resolveNpmCli())('tar');

test('real archive producer supplies integrity and extraction validates it for .tar and .tar.gz, including failures', async () => {
  for (const ext of ['.tar', '.tar.gz']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-progress-'));
    try {
      const input = path.join(root, 'input');
      fs.mkdirSync(input);
      fs.writeFileSync(path.join(input, 'Clowder AI.exe'), `entry-${ext}`);
      const file = path.join(root, `bundled/archives/electron${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const manifest = await createRuntimeArchive(input, file);
      const header = fs.readFileSync(file).subarray(0, 2);
      assert.equal(header[0] === 0x1f && header[1] === 0x8b, ext === '.tar.gz', `${ext} compression header`);
      const events = [];
      await extractRuntimeArchive(root, path.basename(file), tar, { onProgress: (e) => events.push(e) });
      assert.equal(events[0].status, 'start');
      assert.equal(events.at(-1).entries, manifest.entries);
      assert.equal(events.at(-1).percent, 100);
      assert.equal(fs.readFileSync(path.join(root, 'desktop-dist/Clowder AI.exe'), 'utf8'), `entry-${ext}`);
      fs.writeFileSync(file + '.json', JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
      await assert.rejects(
        extractRuntimeArchive(root, path.basename(file), tar, { onProgress: (e) => events.push(e) }),
        /integrity mismatch/,
      );
      assert.equal(events.at(-1).status, 'failed');
      fs.renameSync(file + '.json', file + '.saved-manifest');
      await assert.rejects(extractRuntimeArchive(root, path.basename(file), tar), /manifest/i);
      await assert.rejects(createRuntimeArchive(input, file), /must be new/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('all five sidecar-backed .tar archives validate SHA-256, entry count, and expected entry file', async () => {
  const cases = [
    ['deploy-dependencies', 'node_modules', '.runtime-lock.json'],
    ['deploy-api', 'packages/api', 'dist/index.js'],
    ['deploy-web', 'packages/web', '.next/BUILD_ID'],
    ['deploy-mcp-server', 'packages/mcp-server', 'dist/index.js'],
    ['electron', 'desktop-dist', 'Clowder AI.exe'],
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-all-five-'));
  try {
    fs.mkdirSync(path.join(root, 'bundled/archives'), { recursive: true });
    for (const [name, destDir, expectedRel] of cases) {
      const input = path.join(root, 'src', name);
      const entryPath = path.join(input, expectedRel);
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, `payload-${name}`);
      const archiveFile = path.join(root, 'bundled/archives', `${name}.tar`);
      const manifest = await createRuntimeArchive(input, archiveFile);
      await extractRuntimeArchive(root, `${name}.tar`, tar);
      assert.equal(fs.readFileSync(path.join(root, destDir, expectedRel), 'utf8'), `payload-${name}`);

      // Corrupt a payload byte (preserving tar header & total size): SHA-256 check must reject it.
      const tampered = fs.readFileSync(archiveFile);
      const payloadOffset = tampered.indexOf(Buffer.from(`payload-${name}`));
      assert.ok(payloadOffset >= 0, `expected payload bytes inside ${name}.tar`);
      tampered[payloadOffset] ^= 0x01;
      fs.writeFileSync(archiveFile, tampered);
      await assert.rejects(extractRuntimeArchive(root, `${name}.tar`, tar), /integrity mismatch/);
      assert.equal(manifest.archive, `${name}.tar`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waiting for tar emits diagnostic heartbeats before completion and stops them on exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-heartbeat-'));
  try {
    const input = path.join(root, 'input');
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'Clowder AI.exe'), 'entry');
    const file = path.join(root, 'bundled/archives/electron.tar');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await createRuntimeArchive(input, file);
    const { Writable } = await import('node:stream');
    const events = [];
    const fakeTar = {
      x: (options) =>
        new Writable({
          write(chunk, encoding, callback) {
            setTimeout(callback, 60);
          },
          final(callback) {
            options.filter('Clowder AI.exe', { type: 'File' });
            fs.writeFileSync(path.join(options.cwd, 'Clowder AI.exe'), 'entry');
            callback(new Error('delayed write failure'));
          },
        }),
    };
    await assert.rejects(
      extractRuntimeArchive(root, path.basename(file), fakeTar, { intervalMs: 5, onProgress: (e) => events.push(e) }),
      /delayed write failure/,
    );
    assert.ok(events.some((e) => e.status === 'progress' && e.elapsedMs > 0 && e.rssBytes > 0 && e.cpu));
    assert.equal(events.at(-1).status, 'failed');
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.length, count);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows shell excludes runtime resources and every distribution carries the shared tree', () => {
  const require = createRequire(import.meta.url);
  assert.deepEqual(require('./windows-builder.cjs').extraResources, []);
  const script = fs.readFileSync(new URL('./scripts/build-desktop.ps1', import.meta.url), 'utf8');
  assert.match(script, /--config windows-builder.cjs/);
  assert.match(script, /"dependencies"\) "node_modules"/);
  const iss = fs.readFileSync(new URL('./installer/cat-cafe.iss', import.meta.url), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const skillsResources = packageJson.build.extraResources.filter((entry) => entry.to.startsWith('cat-cafe-skills'));
  assert.match(iss, /ExecAndLogOutput[\s\S]*@ExtractionOutput/);
  assert.match(iss, /deploy-dependencies\.tar/);
  assert.doesNotMatch(iss, /Flags:\s*nocompression/);
  assert.match(iss, /Excludes: [^\n]*\.cat-cafe-shared-refs/);
  assert.match(iss, /Excludes:\s*"\.cat-cafe-shared-refs\*"/);
  assert.match(iss, /cat-cafe-skills\\refs\\\*[^\n]*\.cat-cafe-shared-refs/);
  assert.match(iss, /\[InstallDelete\][\s\S]*cat-cafe-skills\\\.cat-cafe-shared-refs/);
  assert.equal(skillsResources.length, 2);
  assert.match(JSON.stringify(skillsResources), /!\*\*\/.cat-cafe-shared-refs/);
  assert.match(JSON.stringify(skillsResources), /cat-cafe-skills\\?\/.cat-cafe-shared-refs/);
});

test('installer failure prevents later setup actions and cannot report success', () => {
  const iss = fs.readFileSync(new URL('./installer/cat-cafe.iss', import.meta.url), 'utf8');
  const run = iss.match(/^\[Run\]([\s\S]*?)^\[/m)[1];
  for (const entry of run.split(/(?=^Filename:)/m).slice(1))
    assert.match(entry, /Check: (RuntimeExtractionSucceeded|ShouldAutoLaunch)/);
  const failure = fs.readFileSync(new URL('./installer/runtime-failure.iss', import.meta.url), 'utf8');
  assert.match(iss, /#include "runtime-failure.iss"/);
  assert.match(failure, /function GetCustomSetupExitCode[\s\S]*RuntimeFailure[\s\S]*Result := 20/);
  assert.match(failure, /procedure CancelButtonClick[\s\S]*Confirm := False/);
  assert.match(failure, /RuntimeFailure :=[\s\S]*WizardForm.Close/);
});
