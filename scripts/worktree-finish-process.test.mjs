import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, SOURCE } from './lib/worktree-finish-fixture.mjs';

const script = fileURLToPath(new URL('./worktree-finish.mjs', import.meta.url));
const env = { ...process.env, CAT_CAFE_CAT_ID: 'codex61-sol' };
const args = (path) => [script, path, '--source-ref', SOURCE];

describe('finish observes consumers rather than its invocation wrappers', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('releases an absolute target invoked through a live shell wrapper', () => {
    const path = fx.make();
    // The trailing command keeps the shell alive instead of optimizing it into exec.
    const out = execFileSync('/bin/sh', ['-c', '"$@" && :', 'wrapper', process.execPath, ...args(path)], {
      cwd: fx.repo,
      encoding: 'utf8',
      env,
    });
    assert.equal(JSON.parse(out).state, 'released');
    assert.equal(fx.finish(path, { mode: 'check' }).state, 'released');
  });

  it('releases an absolute target through the real pnpm entry point', () => {
    const path = fx.make();
    writeFileSync(
      join(fx.repo, 'package.json'),
      JSON.stringify({
        scripts: { 'worktree:finish': `node '${script.replaceAll("'", "'\\''")}'` },
      }),
    );
    const out = execFileSync('pnpm', ['--silent', 'worktree:finish', path, '--source-ref', SOURCE], {
      cwd: fx.repo,
      encoding: 'utf8',
      env,
    });
    assert.equal(JSON.parse(out.trim()).state, 'released');
  });

  it('still blocks the live parent shell whose cwd is inside the target', () => {
    const path = fx.make();
    const run = spawnSync(
      '/bin/sh',
      [
        '-c',
        '"$@"; :',
        'parent',
        '/bin/sh',
        '-c',
        'cd "$1"; shift; exec "$@"',
        'child',
        fx.repo,
        process.execPath,
        ...args(path),
      ],
      {
        cwd: path,
        encoding: 'utf8',
        env,
      },
    );
    const result = JSON.parse(run.stderr.trim());
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /busy.*cwd.*pid=\d+/);
    assert.equal(existsSync(path), true);
  });

  it('still blocks a real ancestor program loaded from the target while its cwd is elsewhere', () => {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe'));
    const consumer = join(path, '.cat-cafe/consumer.mjs');
    writeFileSync(
      consumer,
      `import { spawnSync } from 'node:child_process';
const r = spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify(args(path))}, {encoding:'utf8'});
process.stderr.write(r.stderr); process.exitCode = r.status;
`,
    );
    const run = spawnSync(process.execPath, [consumer], { cwd: fx.repo, encoding: 'utf8', env });
    assert.equal(run.status, 1);
    assert.match(JSON.parse(run.stderr.trim()).reason, /busy.*argv.*pid=\d+.*node/);
    assert.equal(existsSync(path), true);
  });
});
