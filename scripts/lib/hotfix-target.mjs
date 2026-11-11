import { execFileSync } from 'node:child_process';

export function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

export function parseOptions(args, env) {
  const numbers = env.PR_NUMBER === undefined ? [] : [env.PR_NUMBER];
  const options = { base: env.HOTFIX_BASE, head: env.HOTFIX_HEAD, applyLabel: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^[1-9]\d*$/.test(arg)) {
      numbers.push(arg);
      continue;
    }
    if (!['--base', '--head', '--pr', '--apply-label'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`);
    if (['--base', '--head'].includes(arg)) options[arg.slice(2)] = value;
    else numbers.push(value);
    if (arg === '--apply-label') options.applyLabel = true;
  }
  return validateOptions(options, numbers);
}

function validateOptions(options, numbers) {
  if (numbers.some((n) => !/^[1-9]\d*$/.test(n) || !Number.isSafeInteger(Number(n)))) {
    throw new Error('PR number must be a positive safe integer');
  }
  if (new Set(numbers).size > 1) throw new Error('Conflicting PR numbers');
  options.prNumber = numbers[0];
  for (const key of ['base', 'head']) {
    const ref = options[key];
    if (ref !== undefined && (!ref || ref.startsWith('-') || ref.length > 1024))
      throw new Error(`Invalid ${key} revision`);
  }
  return options;
}

function resolveCommit(ref) {
  return run('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

function originRepository() {
  const origin = run('git', ['config', '--get', 'remote.origin.url']).trim();
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(
      origin,
    );
  if (!match) throw new Error('PR analysis requires an unambiguous GitHub origin');
  return match[1];
}

export function readPr(repository, prNumber) {
  const snapshot = JSON.parse(
    run('gh', ['pr', 'view', prNumber, '--repo', repository, '--json', 'number,url,title,baseRefOid,headRefOid']),
  );
  const expectedUrl = `https://github.com/${repository}/pull/${prNumber}`;
  if (
    snapshot.number !== Number(prNumber) ||
    snapshot.url?.toLowerCase() !== expectedUrl.toLowerCase() ||
    typeof snapshot.title !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(snapshot.baseRefOid ?? '') ||
    !/^[a-f0-9]{40}$/i.test(snapshot.headRefOid ?? '')
  ) {
    throw new Error('Invalid PR snapshot or PR belongs to a different repository');
  }
  return snapshot;
}

export function resolveTarget(options) {
  run('git', ['rev-parse', '--show-toplevel']);
  let snapshot;
  let repository;
  let base;
  let head;
  if (options.prNumber) {
    repository = originRepository();
    snapshot = readPr(repository, options.prNumber);
    const shas = [...new Set([snapshot.baseRefOid, snapshot.headRefOid])];
    const types = run('git', ['cat-file', '--batch-check=%(objecttype)'], {
      input: `${shas.map((sha) => `${sha}^{commit}`).join('\n')}\n`,
    })
      .trim()
      .split('\n');
    const missing = shas.filter((_, i) => types[i] !== 'commit');
    if (missing.length) run('git', ['fetch', '--no-tags', 'origin', ...missing]);
    base = resolveCommit(snapshot.baseRefOid);
    head = resolveCommit(snapshot.headRefOid);
    for (const [key, sha] of [
      ['base', base],
      ['head', head],
    ]) {
      if (options[key] !== undefined && resolveCommit(options[key]) !== sha) {
        throw new Error(`Explicit ${key} revision does not match the target PR`);
      }
    }
  } else {
    base = resolveCommit(options.base ?? 'origin/main');
    head = resolveCommit(options.head ?? 'HEAD');
  }
  const mergeBase = run('git', ['merge-base', base, head]).trim();
  if (mergeBase === head && base !== head) throw new Error('Target HEAD is behind base; no feature range to analyze');
  return {
    scope: { kind: snapshot ? 'pr' : 'local', repository, prNumber: options.prNumber, base, head, mergeBase },
    snapshot,
  };
}

export function verifyLabelTarget(target) {
  const current = readPr(target.scope.repository, target.scope.prNumber);
  for (const key of ['title', 'baseRefOid', 'headRefOid']) {
    if (current[key] !== target.snapshot[key])
      throw new Error('PR changed during analysis; rerun before applying a label');
  }
}
