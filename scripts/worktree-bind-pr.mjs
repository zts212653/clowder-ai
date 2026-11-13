#!/usr/bin/env node
/** Link a declared checkout to an exact PR without rewriting its original birth provenance. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOrigin } from './lib/worktree-origin.mjs';
import { parsePrSource, readPrTruth } from './lib/worktree-pr.mjs';
import { writePrBinding } from './lib/worktree-pr-config.mjs';
import { safeRealpath } from './lib/worktree-reaper-probes.mjs';
import { retentionStatus } from './lib/worktree-retention.mjs';
import { ownedWorktreeFacts } from './worktree-finish.mjs';
import { mainRepoFrom } from './worktree-reaper.mjs';

const sha = (value) => /^[0-9a-f]{40}$/.test(value ?? '');
const text = (value) => typeof value === 'string' && value.trim() && value.length <= 2000 && !/[\r\n\0]/.test(value);
const readRepositoryTruth = (repo) =>
  execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function requireTruth(truth, sourceRef, states) {
  if (
    truth?.sourceRef !== sourceRef ||
    !states.includes(truth.state) ||
    !sha(truth.head) ||
    !Array.isArray(truth.commits) ||
    !truth.commits.length ||
    !truth.commits.every(sha) ||
    !truth.commits.includes(truth.head) ||
    (truth.state === 'MERGED' && !sha(truth.mergedAt))
  )
    throw new Error('PR truth unavailable or invalid');
}

function correctionHistory(lifecycle) {
  const history = lifecycle.prBindingHistory;
  if (history === undefined) return [];
  if (!Array.isArray(history)) throw new Error('invalid PR binding history');
  for (let i = 0; i < history.length; i++) {
    const row = history[i];
    if (
      !row ||
      !sha(row.head) ||
      !text(row.owner) ||
      !text(row.reason) ||
      !Number.isFinite(Date.parse(row.recordedAt)) ||
      row.from === row.to ||
      parsePrSource(row.from).repository !== parsePrSource(row.to).repository ||
      (i > 0 && history[i - 1].to !== row.from)
    )
      throw new Error('invalid PR binding history');
  }
  if (history.length && history.at(-1).to !== lifecycle.prSource) throw new Error('PR binding history source mismatch');
  return history;
}

function checkedCorrection(entry, { sourceRef, replacePr, expectedHead, reason }, repo, readRepository) {
  const { repository } = parsePrSource(sourceRef);
  if (replacePr === undefined) {
    if (expectedHead !== undefined || reason !== undefined) throw new Error('correction flags require --replace-pr');
    if (entry.lifecycle.prSource && entry.lifecycle.prSource !== sourceRef)
      throw new Error('checkout already belongs to another PR; use explicit --replace-pr correction');
    return undefined;
  }
  if (!text(reason)) throw new Error('correction reason required');
  if (!sha(expectedHead) || entry.head !== expectedHead) throw new Error('exact current expected HEAD required');
  if (replacePr !== entry.lifecycle.prSource || replacePr === sourceRef)
    throw new Error('expected previous PR binding mismatch');
  if (parsePrSource(replacePr).repository !== repository || readRepository(repo) !== repository)
    throw new Error('PR does not belong to the checkout repository');
  validateOrigin(entry.lifecycle.origin);
  if (retentionStatus(entry.lifecycle) === 'retention-invalid') throw new Error('invalid retained source');
  return correctionHistory(entry.lifecycle);
}

export function bindWorktreePr({
  repo,
  path,
  owner,
  sourceRef,
  replacePr,
  expectedHead,
  reason,
  readPr = readPrTruth,
  readRepository = readRepositoryTruth,
}) {
  const opts = { repo: safeRealpath(repo), path: safeRealpath(resolve(path)), owner };
  const entry = ownedWorktreeFacts(opts);
  const replacing = replacePr !== undefined;
  let history = checkedCorrection(entry, { sourceRef, replacePr, expectedHead, reason }, opts.repo, readRepository);
  const truth = readPr(sourceRef);
  if (truth.sourceRef !== sourceRef || !truth.commits?.includes(entry.head))
    throw new Error('PR must include the exact checkout HEAD');
  if (replacing) {
    requireTruth(truth, sourceRef, ['OPEN', 'MERGED']);
    requireTruth(readPr(replacePr), replacePr, ['OPEN', 'CLOSED', 'MERGED']);
    history = [
      ...history,
      {
        from: replacePr,
        to: sourceRef,
        head: entry.head,
        owner,
        reason: reason.trim(),
        recordedAt: new Date().toISOString(),
      },
    ];
  }
  writePrBinding(entry, sourceRef, history, () => {
    const current = ownedWorktreeFacts(opts);
    if (current.head !== entry.head || JSON.stringify(current.lifecycle) !== JSON.stringify(entry.lifecycle))
      throw new Error('worktree HEAD or lifecycle changed before PR binding');
  });
  return {
    path: entry.path,
    owner,
    head: entry.head,
    sourceRef,
    origin: entry.lifecycle.origin,
    ...(replacing
      ? {
          previousSourceRef: replacePr,
          finishSourceRef: entry.lifecycle.retention?.sourceRef ?? sourceRef,
          correction: history.at(-1),
        }
      : {}),
  };
}

export function parseBindPrArgs(argv, env = process.env) {
  const [path, sourceRef, ...rest] = argv;
  if (!path || path.startsWith('--') || !sourceRef)
    throw new Error('usage: worktree-bind-pr path pr:owner/repo#number');
  const opts = { path, sourceRef, owner: env.CAT_CAFE_CAT_ID };
  const flags = {
    '--owner': 'owner',
    '--replace-pr': 'replacePr',
    '--expected-head': 'expectedHead',
    '--reason': 'reason',
  };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = flags[rest[i]];
    if (!key || seen.has(key) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw new Error('invalid bind-pr flag/value');
    seen.add(key);
    opts[key] = rest[i + 1];
  }
  if (env.CAT_CAFE_CAT_ID && opts.owner !== env.CAT_CAFE_CAT_ID) throw new Error('owner differs from runtime identity');
  return opts;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        bindWorktreePr({ repo: mainRepoFrom(process.cwd()), ...parseBindPrArgs(process.argv.slice(2)) }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
