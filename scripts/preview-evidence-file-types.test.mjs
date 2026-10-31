import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test(
  'bounded evidence reads refuse a FIFO instead of waiting for a writer',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-evidence-fifo-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fifo = join(root, 'evidence.json');
    execFileSync('mkfifo', [fifo]);
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { recoverySnapshot } from ${JSON.stringify(new URL('./lib/preview-alpha-recovery-evidence.mjs', import.meta.url).href)}; recoverySnapshot(process.argv[1]);`,
        fifo,
      ],
      { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env: { ...process.env, HOME: root } },
    );
    assert.equal(r.error, undefined, 'a non-regular evidence file must fail without an open/read timeout');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /bounded regular file/);
  },
);
