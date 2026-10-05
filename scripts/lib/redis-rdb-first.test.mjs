import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Shell/protocol executable fixtures check ordering and generic compatibility.
// Real Redis/OS incarnation evidence is in alpha-named-storage.test.mjs.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'redis-hook-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls');
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'redis-server'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo "Redis server v=7.0.0"; else echo spawn >> "$REDIS_HOOK_TEST_LOG"; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'redis-cli'),
    '#!/bin/sh\necho "protocol $*" >> "$REDIS_HOOK_TEST_LOG"\ncase "$*" in *" config get appendonly") printf "appendonly\\nyes\\n" ;; *) echo OK ;; esac\n',
    { mode: 0o755 },
  );
  return {
    run(options = '', callback = 'return 0') {
      return spawnSync(
        'bash',
        [
          '-c',
          `set -e\nsource "$1"\nnamed_alpha_capture_redis_identity() { echo "fixed-capture $*" >> "$REDIS_HOOK_TEST_LOG"; ${callback}; }\ncat_cafe_redis_start_daemon --port 15123 --dir "$2" --pidfile "$2/redis.pid" ${options}\n`,
          '_',
          new URL('./redis-rdb-first.sh', import.meta.url).pathname,
          directory,
        ],
        {
          cwd: directory,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            REDIS_HOOK_TEST_LOG: log,
            REDIS_START_HOOK: 'touch forbidden-side-effect',
          },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
    },
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
    forbiddenExists: () => existsSync(join(directory, 'forbidden-side-effect')),
  };
}

test('generic caller keeps normal protocol startup and never invokes the named ownership hook', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0], 'spawn');
  assert.match(f.calls()[1], /^protocol .* ping$/);
  assert.equal(
    f.calls().some((line) => line.startsWith('fixed-capture')),
    false,
  );
  assert.equal(f.forbiddenExists(), false, 'an environment string does not receive execution authority');
});

test('named startup executes only its fixed capture before the first protocol command', (t) => {
  const f = fixture(t);
  const result = f.run('--named-alpha-ownership');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0], 'spawn');
  assert.match(f.calls()[1], /^fixed-capture 15123 .*\/redis\.pid$/);
  assert.match(f.calls()[2], /^protocol .* ping$/);
});

test('capture refusal performs no Redis protocol and an arbitrary hook option cannot fork a server', (t) => {
  const denied = fixture(t);
  assert.notEqual(denied.run('--named-alpha-ownership', 'return 1').status, 0);
  assert.equal(
    denied.calls().some((line) => line.startsWith('protocol')),
    false,
  );
  const arbitrary = fixture(t);
  assert.notEqual(arbitrary.run('--after-start forbidden').status, 0);
  assert.deepEqual(arbitrary.calls(), ['']);
});
