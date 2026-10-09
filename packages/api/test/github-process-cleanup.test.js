import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createCiCdCheckTaskSpec } from '../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { fetchPrCiStatuses } from '../dist/infrastructure/email/ci-status-batch-fetcher.js';
import { executeGitHubRequest } from '../dist/infrastructure/github/request-budget.js';
import { executeTaskPipeline } from '../dist/infrastructure/scheduler/execute-pipeline.js';

// Readiness polling must keep real I/O time while the scheduler deadline is controlled.
const realDelay = delay;
async function waitFile(path) {
  for (let i = 0; i < 500; i++) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await realDelay(10);
    }
  }
  throw new Error(`fake gh did not create ${path}`);
}
async function fakeGh(ignoreTerm, run, startupDelayMs = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'cat-cafe-gh-cleanup-'));
  const started = join(dir, 'started'),
    term = join(dir, 'term'),
    closed = join(dir, 'closed'),
    release = join(dir, 'release');
  const oldPath = process.env.PATH;
  const oldLocalCommandFixtures = process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES;
  await writeFile(
    join(dir, 'gh'),
    `#!${process.execPath}\nconst fs=require('node:fs');\nsetTimeout(()=>{\nprocess.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(term)},'term');${ignoreTerm ? '' : `setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);},10);`}});\nprocess.on('exit',()=>fs.writeFileSync(${JSON.stringify(closed)},'closed'));\nfs.writeFileSync(${JSON.stringify(started)},String(process.pid));\nsetInterval(()=>{},1000);\n},${startupDelayMs});\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES = join(dir, 'gh');
  let pid;
  try {
    await run({
      started,
      term,
      closed,
      release,
      setPid(value) {
        pid = value;
      },
    });
  } finally {
    process.env.PATH = oldPath;
    if (oldLocalCommandFixtures === undefined) delete process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES;
    else process.env.CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES = oldLocalCommandFixtures;
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await realDelay(30);
    await rm(dir, { recursive: true, force: true });
  }
}
const unixOnly = { skip: process.platform === 'win32' ? 'POSIX shebang/PATH fake-gh fixture' : false };
const log = { info() {}, warn() {}, error() {} };
test(
  'real gh abort retains the CI gate until the child close event, beyond execFile callback rejection',
  unixOnly,
  async (t) => {
    await fakeGh(
      false,
      async (paths) => {
        const store = new TaskStore();
        store.create({
          kind: 'pr_tracking',
          threadId: 't',
          subjectKey: 'pr:owner/repo#1',
          title: 'tracked',
          ownerCatId: 'codex-astra',
          why: 'test',
          createdBy: 'codex-astra',
        });
        const spec = createCiCdCheckTaskSpec({
          taskStore: store,
          log,
          cicdRouter: {},
          fetchPrStatuses: (targets, signal) =>
            fetchPrCiStatuses(targets, log, { ghToken: 'real-gh-gate-cleanup', signal }),
        });
        spec.admission.timeoutMs = 1500;
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const context = {
          task: spec,
          ledger: { record() {} },
          logger: log,
          running: new Map(),
          tickCounts: new Map(),
          lastRunAt: new Map(),
        };
        const pending = executeTaskPipeline(context).then(
          () => null,
          (error) => error,
        );
        paths.setPid(Number(await waitFile(paths.started)));
        // Slow process startup cannot consume the deadline before the scenario begins.
        t.mock.timers.tick(spec.admission.timeoutMs);
        await waitFile(paths.term);
        await realDelay(30);
        const stillOwned = context.running.get(spec.id);
        assert.equal(stillOwned, true, 'SIGTERM is not child close');
        await writeFile(paths.release, 'release');
        const error = await pending;
        const closedAtReturn = await readFile(paths.closed, 'utf8').catch(() => undefined);
        assert.equal(closedAtReturn, 'closed', 'promise must join real process cleanup');
        assert.match(String(error), /admission timed out/);
      },
      1700,
    );
  },
);
test('real gh ignoring SIGTERM is forcibly reaped before the cancelled caller completes', unixOnly, async () => {
  await fakeGh(true, async (paths) => {
    const controller = new AbortController();
    const pending = executeGitHubRequest(['api', '/fixture'], {
      ghToken: 'real-gh-kill-cleanup',
      signal: controller.signal,
    }).then(
      () => null,
      (error) => error,
    );
    const pid = Number(await waitFile(paths.started));
    paths.setPid(pid);
    controller.abort(new Error('stop fake gh'));
    const error = await pending;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'an AbortError callback cannot release a still-running child');
    assert.match(String(error), /stop fake gh/);
  });
});
