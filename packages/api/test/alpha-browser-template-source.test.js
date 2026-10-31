import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { createAlphaBrowserTemplate } from '../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { fixture } from './helpers/alpha-browser-template-fixture.js';

// These exact integrations require the installed home dossier and private Alpha
// gate execution plane. Portable scheduler contracts remain in the sibling file.
test('production default readers enforce the actual dossier and current roster before owner dispatch', async (t) => {
  const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const roster = getRoster();
  const previousAvailability = roster['codex-sol'].available;
  process.env.CAT_CAFE_CONFIG_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  t.after(() => {
    roster['codex-sol'].available = previousAvailability;
    if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
  });
  for (const [ownerCatId, available, expected] of [
    ['fable-5', true, 'codex-astra'],
    ['opus55', true, 'codex-astra'],
    ['codex-sol', true, 'codex-sol'],
    ['codex-sol', false, 'codex-astra'],
  ]) {
    const f = fixture();
    delete f.options.isAvailable;
    delete f.options.getEngagementPolicy;
    f.options.resolveCat = (id) => id;
    f.params.params.guardianCatId = 'codex-astra';
    roster['codex-sol'].available = available;
    const drafts = f.runtime.alphaBrowserFailureTasks;
    f.runtime.alphaBrowserFailureTasks = async () => (await drafts()).map((draft) => ({ ...draft, ownerCatId }));
    const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
    await spec.run.execute('alpha', 'alpha', f.context);
    assert.deepEqual(
      f.delivered.map((message) => [message.targetCatId, message.userId]),
      [[expected, 'owner']],
    );
    assert.ok(f.delivered.every((message) => message.deliveryStatus === 'queued'));
    assert.deepEqual(f.triggered, [], 'scheduler delivery enters the canonical Queue without a second trigger');
    assert.equal([...f.tasks.values()][0].ownerCatId, ownerCatId);
  }
});

test('default scheduler runtime keeps HTTP responsive while its Alpha child waits on SQLite', async (t) => {
  const { execFileSync, fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { createServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { openGateExecutionStore } = await import('../../../scripts/lib/gate-execution-db.mjs');
  const root = mkdtempSync(join(tmpdir(), 'alpha-template-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Template Fixture');
  git('config', 'user.email', 'template@example.invalid');
  git('commit', '--allow-empty', '-qm', 'baseline');
  const sha = git('rev-parse', 'HEAD');
  symlinkSync(fileURLToPath(new URL('../../../scripts', import.meta.url)), join(root, 'scripts'), 'dir');
  const databasePath = join(root, '.git', 'gate.sqlite');
  openGateExecutionStore(databasePath).close();
  const writerPath = join(root, 'writer.mjs');
  writeFileSync(
    writerPath,
    `import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[2]); db.exec('BEGIN IMMEDIATE'); process.send('locked');
    setTimeout(()=>{db.exec('ROLLBACK');db.close();process.disconnect()},1000);`,
  );
  const writer = fork(writerPath, [databasePath], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(writer, 'close');
  t.after(() => writer.kill());
  await once(writer, 'message');
  const server = createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const f = fixture();
  const options = {
    ...f.options,
    repoRoot: root,
    inspectMain: async () => ({ targetSha: sha, databasePath, legacyLockPath: join(root, '.git', 'legacy') }),
  };
  delete options.loadRuntime;
  const params = { ...f.params, params: { ...f.params.params, baselineSha: sha } };
  const spec = createAlphaBrowserTemplate(options).createSpec('alpha-subscription', params);
  const started = performance.now();
  const http = fetch(`http://127.0.0.1:${server.address().port}/health`).then(async (r) => {
    assert.equal(await r.text(), 'ok');
    return performance.now() - started;
  });
  const work = spec.run.execute('alpha', 'alpha', f.context);
  const httpMs = await http;
  assert.ok(httpMs < 400, `API HTTP took ${httpMs}ms during Alpha lock wait`);
  await work;
  await closed;
  assert.equal(f.tasks.size, 0);
});
