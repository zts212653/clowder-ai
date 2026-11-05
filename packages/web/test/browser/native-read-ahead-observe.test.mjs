import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { waitForNativeReady } from './native-team-startup-ready.mjs';

// Explicit installed-artifact lane, never a default fixture or model simulation.
// Observes the exact launch's durable output; does not start an app or warm files
// before its first startup, and does not mutate any profile or configuration.
test(
  'the installed candidate actually consumes its own startup hints instead of silently skipping them',
  { timeout: 160000 },
  async () => {
    const file = process.env.CAT_CAFE_STARTUP_READ_AHEAD_LAUNCH;
    assert.ok(file && path.isAbsolute(file), 'Supply the explicitly owned fresh launch receipt');
    const launch = JSON.parse(await fs.readFile(file, 'utf8'));
    await waitForNativeReady(path.join(launch.instance, 'data/logs/startup-state.json'), launch.pid);
    const identity = JSON.parse(await fs.readFile(path.join(launch.app, 'desktop-instance.json'), 'utf8'));
    assert.equal(await fs.realpath(identity.CAT_CAFE_DESKTOP_INSTANCE_ROOT), await fs.realpath(launch.instance));
    for (const name of ['FRONTEND_PORT', 'API_SERVER_PORT', 'REDIS_PORT'])
      assert.ok(![3003, 3004, 6399].includes(Number(identity[name])));
    const entry = path.join(launch.app, 'packages/api/dist/index.desktop.js');
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(entry), '.startup-read-ahead.json'), 'utf8'));
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(entry))
        .digest('hex'),
      manifest.entrySha256,
    );
    const log = await fs.readFile(path.join(launch.instance, 'data/logs/desktop.log'), 'utf8');
    const prefix = '[api-startup-read-ahead] ';
    const events = log
      .split('\n')
      .filter((line) => {
        const time = /^\[([^\]]+)\]/.exec(line)?.[1];
        return Date.parse(time) >= Date.parse(launch.started) && line.includes(prefix);
      })
      .map((line) => JSON.parse(line.slice(line.indexOf(prefix) + prefix.length)));
    assert.equal(events.length, 1, 'Exactly one API read-ahead result belongs to this launch');
    const [actual] = events;
    assert.equal(actual.status, 'ready', 'A healthy API fallback cannot pass performance-fix acceptance');
    assert.equal(actual.files, manifest.files.length);
    assert.equal(
      actual.bytes,
      manifest.files.reduce((sum, item) => sum + item.bytes, 0),
    );
    assert.equal(actual.errors, 0);
    assert.ok(Number.isSafeInteger(actual.budgetMs) && actual.budgetMs > 0 && actual.budgetMs <= 15000);
    assert.ok(actual.elapsedMs <= actual.budgetMs);
    await fs.writeFile(
      `${file}.read-ahead-observed.json`,
      JSON.stringify({ ...launch, actual, expectedFiles: manifest.files.length }, null, 2),
    );
    console.log(JSON.stringify({ source: launch.source, packageSha256: launch.packageSha256, ...actual }));
  },
);
