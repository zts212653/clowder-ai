import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { durableWorktreeConsumers } from './lib/worktree-consumers.mjs';
import { fixture } from './lib/worktree-finish-fixture.mjs';

test('a queued durable consumer protects a worktree even with no live process', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const path = f.make();
  const dir = join(f.root, 'data', 'managed-jobs');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'supervisor.sqlite'));
  db.exec('CREATE TABLE managed_jobs(job_id TEXT, state TEXT, record_json TEXT)');
  db.prepare('INSERT INTO managed_jobs VALUES(?,?,?)').run(
    'queued-fixture',
    'queued',
    JSON.stringify({ descriptor: { definition: { cwd: path, command: 'node check.mjs' } } }),
  );
  db.close();
  assert.throws(() => f.finish(path, { dataRoot: join(f.root, 'data') }), /queued-fixture/);
});

test('gate queue paths use directory boundaries; nonterminal plans without a location stay protected', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const path = f.make();
  const db = new DatabaseSync(join(f.repo, '.git', 'cat-cafe-full-gate-resources.sqlite'));
  db.exec(
    'CREATE TABLE gate_resource_requests(request_id TEXT, cwd TEXT); CREATE TABLE gate_execution_jobs(job_id TEXT, state TEXT, plan_json TEXT, materialization_json TEXT)',
  );
  db.prepare('INSERT INTO gate_resource_requests VALUES(?,?)').run('ours', join(path, 'packages/web'));
  db.prepare('INSERT INTO gate_resource_requests VALUES(?,?)').run('neighbor', `${path}-neighbor`);
  const insert = db.prepare('INSERT INTO gate_execution_jobs VALUES(?,?,?,NULL)');
  insert.run('old-unknown', 'queued', JSON.stringify({ command: { cwd: '.' } }));
  insert.run('known-neighbor', 'queued', JSON.stringify({ command: { cwd: `${path}-neighbor` } }));
  insert.run('done', 'terminal', JSON.stringify({ command: { cwd: path } }));
  db.close();
  assert.deepEqual(
    durableWorktreeConsumers({ repo: f.repo, path, dataRoot: join(f.root, 'data') }).map((row) => row.id),
    ['ours', 'old-unknown'],
  );
  assert.throws(() => f.finish(path), /ours/);
});

test('unreadable durable state cannot be treated as proof of idle', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const path = f.make();
  writeFileSync(join(f.repo, '.git', 'cat-cafe-full-gate-resources.sqlite'), 'corrupt');
  assert.throws(() => f.finish(path), /database/);
});

test('terminal primary legacy receipt wins over its stale running sidecar', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const path = f.make();
  const dir = join(f.root, 'data', 'managed-gate-jobs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ state: 'terminal', cwd: path }));
  writeFileSync(join(dir, 'job.gate.json'), JSON.stringify({ state: 'running', cwd: path }));
  assert.equal(f.finish(path, { dataRoot: join(f.root, 'data') }).state, 'released');
});
