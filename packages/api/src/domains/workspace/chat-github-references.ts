import { type ChatGitHubReference, parseChatGitHubUrl } from '@cat-cafe/shared';
import { buildGhCliEnv } from '../../infrastructure/github/gh-cli-env.js';
import { executeGitHubProcess } from '../../infrastructure/github/gh-process.js';

type Entry = { until: number; value: Promise<ChatGitHubReference> };
function rollup(value: unknown): ChatGitHubReference['checks'] {
  if (!Array.isArray(value) || !value.length) return undefined;
  const states = value.map((check: unknown) => {
    if (!check || typeof check !== 'object') return '';
    const item = check as Record<string, unknown>;
    return String(item.conclusion || item.state || item.status || '').toUpperCase();
  });
  if (
    states.some((state) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(state),
    )
  )
    return 'checksFailed';
  if (states.some((state) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'REQUESTED', 'WAITING'].includes(state)))
    return 'checksPending';
  return states.includes('SUCCESS') && states.every((state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state))
    ? 'checksPassed'
    : undefined;
}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** Bounded read-through cache includes failures and in-flight requests, without serving stale state as current. */
export function createChatGitHubReader(execute = executeGitHubProcess, now = Date.now) {
  const cache = new Map<string, Entry>();
  let active = 0;
  const waiting: Array<() => void> = [];
  async function acquire(): Promise<boolean> {
    if (active < 4) {
      active++;
      return true;
    }
    if (waiting.length >= 32) return false;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return true;
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  return async (reference: string): Promise<ChatGitHubReference | null> => {
    const parsed = parseChatGitHubUrl(reference);
    if (!parsed) return null;
    const key = parsed.url.toLowerCase();
    const prior = cache.get(key);
    if (prior && prior.until > now()) return prior.value;
    if (cache.size >= 512) cache.delete(cache.keys().next().value!);
    const value = (async (): Promise<ChatGitHubReference> => {
      const fallback: ChatGitHubReference = { kind: 'github', ...parsed };
      if (!(await acquire())) return fallback;
      try {
        const { stdout } = await execute(
          'gh',
          ['api', `repos/${parsed.repo}/${parsed.objectType === 'pull' ? 'pulls' : 'issues'}/${parsed.number}`],
          {
            timeout: 5000,
            maxBuffer: 128 * 1024,
            windowsHide: true,
            env: buildGhCliEnv(),
          },
        );
        const data: unknown = JSON.parse(stdout);
        if (!data || typeof data !== 'object') return fallback;
        const object = data as Record<string, unknown>;
        if (
          object.number !== parsed.number ||
          typeof object.html_url !== 'string' ||
          object.html_url.toLowerCase() !== parsed.url.toLowerCase() ||
          typeof object.title !== 'string' ||
          !['open', 'closed'].includes(String(object.state))
        )
          return fallback;
        let checks: ChatGitHubReference['checks'];
        // The pull object does not prove check success. Empty/unavailable rollups stay unknown.
        const head =
          object.head && typeof object.head === 'object' ? (object.head as Record<string, unknown>).sha : undefined;
        if (parsed.objectType === 'pull' && typeof head === 'string' && /^[a-f0-9]{40}$/.test(head)) {
          try {
            const result = await execute(
              'gh',
              ['pr', 'view', String(parsed.number), '--repo', parsed.repo, '--json', 'headRefOid,statusCheckRollup'],
              {
                timeout: 5000,
                maxBuffer: 128 * 1024,
                windowsHide: true,
                env: buildGhCliEnv(),
              },
            );
            const current: unknown = JSON.parse(result.stdout);
            if (current && typeof current === 'object' && (current as Record<string, unknown>).headRefOid === head)
              checks = rollup((current as Record<string, unknown>).statusCheckRollup);
          } catch {
            /* The independently verified title/state remain usable. */
          }
        }
        const user = object.user && typeof object.user === 'object' ? (object.user as Record<string, unknown>) : null;
        return {
          ...fallback,
          title: object.title.slice(0, 500),
          ...(parsed.objectType === 'pull'
            ? {
                additions: count(object.additions),
                deletions: count(object.deletions),
                changedFiles: count(object.changed_files),
                checks,
              }
            : {}),
          author: typeof user?.login === 'string' ? user.login.slice(0, 100) : undefined,
          updatedAt:
            typeof object.updated_at === 'string' && Number.isFinite(Date.parse(object.updated_at))
              ? object.updated_at
              : undefined,
          state:
            parsed.objectType === 'pull' && typeof object.merged_at === 'string'
              ? 'merged'
              : (object.state as 'open' | 'closed'),
        };
      } catch {
        return fallback;
      } finally {
        release();
      }
    })();
    cache.set(key, { until: now() + 60_000, value });
    return value;
  };
}
