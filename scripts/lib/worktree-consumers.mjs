/** Durable consumers outlive their processes; inspect authoritative records before unloading a tree. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git, safeRealpath } from './worktree-reaper-probes.mjs';

export function worktreeDataRoot(raw = process.env.CAT_CAFE_DATA_DIR) {
  return raw?.trim() ? resolve(raw.trim().replace(/^~(?=\/|$)/, homedir())) : join(homedir(), '.cat-cafe');
}

function references(value, target) {
  if (typeof value === 'string') {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s"'=])${escaped}(?:$|[\\s/"'])`).test(value);
  }
  return !!value && typeof value === 'object' && Object.values(value).some((child) => references(child, target));
}

function readDatabase(file, inspect) {
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    inspect(db, tables);
  } finally {
    db.close();
  }
}

function hasExecutionLocation(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    ['cwd', 'repoRoot', 'checkoutRoot', 'executionRoot'].includes(key) && typeof child === 'string' && isAbsolute(child)
      ? true
      : hasExecutionLocation(child),
  );
}

function gateExecutions(db, common, target, add) {
  for (const row of db
    .prepare("SELECT job_id, plan_json, materialization_json FROM gate_execution_jobs WHERE state != 'terminal'")
    .all()) {
    const input = [JSON.parse(row.plan_json), row.materialization_json ? JSON.parse(row.materialization_json) : null];
    if (references(input, target)) add('gate_execution_jobs', row.job_id);
    else if (row.job_id.startsWith('alpha-browser-')) {
      const digest = row.job_id.slice('alpha-browser-'.length, 'alpha-browser-'.length + 24);
      const checkout = join(dirname(dirname(common)), `${basename(dirname(common))}-alpha-browser-${digest}`);
      if (checkout === target) add('gate_execution_jobs', row.job_id);
    } else if (!hasExecutionLocation(input)) {
      // Older plans have only relative command cwd and no durable execution root.
      // Absence of a path match cannot prove those jobs do not need this checkout.
      add('unlocated_gate_execution', row.job_id);
    }
  }
}

export function durableWorktreeConsumers({ repo, path, dataRoot = worktreeDataRoot() }) {
  const target = safeRealpath(path);
  const commonResult = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonResult.ok) throw new Error('durable consumer repository unknown');
  const common = commonResult.out.trim();
  const consumers = [];
  const add = (kind, id) => consumers.push({ kind, id });
  readDatabase(join(common, 'cat-cafe-full-gate-resources.sqlite'), (db, tables) => {
    for (const table of ['gate_resource_requests', 'gate_resource_holders']) {
      if (!tables.has(table)) continue;
      for (const row of db.prepare(`SELECT request_id, cwd FROM ${table}`).all())
        if (references(row.cwd, target)) add(table, row.request_id);
    }
    if (tables.has('gate_execution_jobs')) gateExecutions(db, common, target, add);
  });
  readDatabase(join(dataRoot, 'managed-jobs', 'supervisor.sqlite'), (db, tables) => {
    if (!tables.has('managed_jobs')) return;
    for (const row of db.prepare("SELECT job_id, record_json FROM managed_jobs WHERE state != 'terminal'").all()) {
      if (references(JSON.parse(row.record_json), target)) add('managed_jobs', row.job_id);
    }
  });
  const legacy = join(dataRoot, 'managed-gate-jobs');
  if (existsSync(legacy)) {
    for (const name of readdirSync(legacy).filter((name) => name.endsWith('.json') && !name.endsWith('.gate.json'))) {
      const record = JSON.parse(readFileSync(join(legacy, name), 'utf8'));
      if (record.state !== 'terminal' && references(record, target)) add('managed-gate-jobs', name.slice(0, -5));
    }
  }
  return consumers;
}

export function requireNoDurableConsumers(options) {
  const consumers = durableWorktreeConsumers(options);
  if (consumers.length)
    throw new Error(`durable worktree consumer: ${consumers.map(({ kind, id }) => `${kind}:${id}`).join(', ')}`);
}
