import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { previewProcessRecordId } from './lib/preview-process-record-key.mjs';
import { removeLaunchdJob } from './preview-process-launchers.mjs';

for (const recordedDirect of [false, true])
  test(`real ${recordedDirect ? 'legacy direct launcher probe failure' : 'canonical named build failure'} -> unclaimed completion -> limited retirement, then fresh port checks`, async (t) => {
    const f = namedAlphaFixture(t);
    f.captureChild();
    const stateDir = join(f.directory, 'preview'),
      registry = join(f.directory, 'leases');
    mkdirSync(stateDir);
    mkdirSync(registry);
    const pnpm = join(f.directory, 'bin/pnpm');
    const original = readFileSync(pnpm, 'utf8').replaceAll('$ALPHA_TEST_CALLS', f.calls);
    const buildMarker = join(f.directory, 'build-entered');
    for (const program of ['lsof', 'redis-cli']) {
      const path = join(f.directory, 'bin', program);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('$ALPHA_TEST_CALLS', f.calls));
    }
    if (recordedDirect) writeFileSync(join(f.directory, 'bin/lsof'), '#!/bin/sh\nsleep 2\nexit 127\n');
    writeFileSync(
      pnpm,
      original.replace(
        'set -eu',
        `set -eu
export CAT_CAFE_SKIP_NODE_RUNTIME_GUARD=1
if [ "$1" = alpha:start ]; then shift; exec bash "${f.mainRoot}/scripts/alpha-worktree.sh" start "$@"; fi
case " $* " in *" build "*) printf build-entered > "${buildMarker}"; sleep 3; exit 2 ;; esac`,
      ),
    );
    const id = previewProcessRecordId(f.mainRoot, 5311),
      recordPath = join(stateDir, `${id}.json`);
    const env = {
      ...process.env,
      ...f.env,
      FIXTURE_MAIN: f.mainRoot,
      CAT_CAFE_PREVIEW_PROCESS_DIR: stateDir,
      CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registry,
    };
    const canonicalArgs = [
      'pnpm',
      'alpha:start',
      '--instance',
      'f290-communication',
      '--ports',
      NAMED_ALPHA_PORTS,
      '--allow-empty-redis',
    ];
    const args = recordedDirect
      ? [
          '/usr/bin/env',
          `PATH=${env.PATH}`,
          'CAT_CAFE_SKIP_NODE_RUNTIME_GUARD=1',
          'CAT_CAFE_CAT_ID=fixture-owner',
          './scripts/alpha-worktree.sh',
          'start',
          ...canonicalArgs.slice(2),
        ]
      : canonicalArgs;
    const invoke = (action, extra = []) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
          action,
          '--cwd',
          f.mainRoot,
          '--port',
          '5311',
          '--json',
          ...extra,
        ],
        {
          cwd: f.mainRoot,
          encoding: 'utf8',
          timeout: 20000,
          env: action === 'start' ? env : { ...env, PATH: process.env.PATH },
        },
      );
    t.after(() => removeLaunchdJob({ launchdLabel: `com.catcafe.preview.${id}` }));
    const start = invoke('start', ['--', ...args]);
    assert.equal(start.status, 1, start.stderr);
    assert.match(start.stderr, /exited before listening/);
    const record = JSON.parse(readFileSync(recordPath));
    const completionBytes = readFileSync(record.completionPath),
      completion = JSON.parse(completionBytes);
    assert.equal(existsSync(buildMarker), !recordedDirect, readFileSync(record.logPath, 'utf8'));
    assert.equal(completion.commandExitCode, recordedDirect ? 1 : 2, readFileSync(record.logPath, 'utf8'));
    assert.equal(completion.cleanupOwnerStatus, 'unclaimed');
    assert.equal(completion.commandGroupStatus, 'absent');
    assert.equal(existsSync(`${record.completionPath}.owner.json`), false);
    const birth = readFileSync(`${record.completionPath}.command.json`);
    const result = invoke('stop');
    assert.equal(result.status, 3, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'registration_retired');
    assert.equal(payload.settlement.commandGroupStatus, 'absent'); // only this new nonce has kernel-bound birth evidence
    assert.equal(payload.settlement.cleanupExitCode, null);
    assert.equal(payload.settlement.persistenceStatus, 'not_reverified');
    assert.equal(existsSync(recordPath), false);
    assert.deepEqual(readFileSync(record.completionPath), completionBytes);
    assert.deepEqual(readFileSync(join(payload.settlement.journalPath, 'command.json')), birth);
    assert.equal(invoke('status').status, 3);
    assert.equal(invoke('stop').status, 3);
    const packaged = spawnSync(
      'pnpm',
      [
        '--dir',
        fileURLToPath(new URL('../', import.meta.url)),
        'preview:process',
        'stop',
        '--cwd',
        f.mainRoot,
        '--port',
        '5311',
        '--json',
      ],
      { cwd: f.mainRoot, encoding: 'utf8', timeout: 10000, env: { ...env, PATH: process.env.PATH } },
    );
    assert.equal(packaged.status, 3, packaged.stderr || packaged.stdout);
    assert.match(packaged.stdout, /registration_retired/);
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(5312, '127.0.0.1', resolve);
    });
    try {
      const next = f.run(['start', '--instance', 'f290-communication', '--ports', NAMED_ALPHA_PORTS], {
        env: { PATH: process.env.PATH },
      });
      assert.notEqual(next.status, 0);
      assert.match(next.stderr, /5312 is occupied/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(existsSync(recordPath), false);
    assert.equal(existsSync(`${record.completionPath}.owner.json`), false);
    // No synthetic owner, Redis protocol, or data write was used to retire this generation.
    assert.equal(f.readCalls().includes('redis-cli '), false);
  });
