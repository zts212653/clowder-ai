/** One-time C1 cutover asset. No runtime route, key discovery, business decoding or legacy writes.
 * The cutover owner supplies a reviewed, bounded source plan separately from the request payload.
 * This copies only that plan, not a claim that all legacy GitHub state has been migrated.
 */
import { createHash } from 'node:crypto';
import { requirePluginOwnerLocalAccess } from '../dist/routes/plugin-access-guards.js';

const MAX_BYTES = 256 * 1024;
const PLUGIN_ID = 'official.github-operations';

function canonical(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid raw snapshot');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function sourceReads(plan) {
  if (Buffer.byteLength(JSON.stringify(plan) ?? '') > MAX_BYTES)
    throw new TypeError('source plan exceeds cutover bound');
  if (plan?.kind === 'issues') {
    if (!Array.isArray(plan.ids) || plan.ids.length > 500 || new Set(plan.ids).size !== plan.ids.length) {
      throw new TypeError('source plan requires at most 500 unique issue IDs');
    }
    return plan.ids.map((id) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new TypeError('invalid source issue ID');
      return { method: 'hgetall', key: `community-issue:${id}`, id };
    });
  }
  if (
    plan?.kind !== 'repositories' ||
    !plan.records ||
    typeof plan.records !== 'object' ||
    Array.isArray(plan.records)
  ) {
    throw new TypeError('invalid source plan');
  }
  const repos = Object.keys(plan.records);
  if (repos.length > 50) throw new TypeError('source plan exceeds 50 repositories');
  return repos.flatMap((repo) => {
    if (repo.length > 200 || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))
      throw new TypeError('invalid canonical repository');
    const keys = plan.records[repo];
    if (!Array.isArray(keys) || keys.length > 5002 || new Set(keys).size !== keys.length) {
      throw new TypeError('source plan exceeds repository key bound or contains duplicates');
    }
    if (keys.filter((key) => typeof key === 'string' && key.startsWith(`f141:notified:${repo}#`)).length > 5000) {
      throw new TypeError('source plan exceeds 5000 notifications');
    }
    return keys.map((key) => {
      const suffix =
        typeof key === 'string' && key.startsWith(`f141:notified:${repo}#`)
          ? key.slice(`f141:notified:${repo}#`.length)
          : '';
      if (
        key !== `f141:baseline:${repo}` &&
        key !== `community:repo-comment:cursor:${repo}` &&
        !/^(issue|pr)-[1-9][0-9]{0,15}$/.test(suffix)
      )
        throw new TypeError('out-of-scope legacy key');
      return { method: 'get', key, repo };
    });
  });
}

function rawSnapshot(kind, repositories, reads, result) {
  const records = Object.create(null);
  for (const repo of repositories) records[repo] = Object.create(null);
  for (let i = 0; i < reads.length; i++) {
    const read = reads[i],
      value = result[i][1];
    if (kind === 'issues') records[read.id] = value;
    else if (value !== null) records[read.repo][read.key] = value;
  }
  return { [kind]: records };
}

export async function copyLegacyGitHubState({ request, redis, operations, plan }) {
  const access = requirePluginOwnerLocalAccess(request, 'write');
  if ('error' in access) return { status: access.status, body: { error: access.error } };
  if (request.body?.confirmed !== true) return { status: 400, body: { error: 'Owner confirmation is required' } };
  const reads = sourceReads(plan);
  const kind = plan.kind;
  const repositories = kind === 'repositories' ? Object.keys(plan.records) : [];
  const transaction = redis.multi();
  for (const read of reads) transaction[read.method](read.key);
  const result = await transaction.exec();
  if (!result || result.length !== reads.length || result.some(([error]) => error))
    throw new Error('legacy snapshot read failed');
  const snapshot = rawSnapshot(kind, repositories, reads, result);
  const bytes = canonical(snapshot);
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    return { status: 413, body: { error: 'legacy snapshot exceeds cutover bound' } };
  const envelope = { protocolVersion: 1, sourceDigest: createHash('sha256').update(bytes).digest('hex'), snapshot };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_BYTES)
    return { status: 413, body: { error: 'legacy envelope exceeds cutover bound' } };
  return operations.runAction(
    PLUGIN_ID,
    kind === 'issues' ? 'legacyIssueObservations' : 'legacyRepositoryProgress',
    'import',
    envelope,
  );
}
