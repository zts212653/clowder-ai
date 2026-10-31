import { hostname } from 'node:os';
import type { HostDependency, HostPlatform, RuntimeRevision } from '@cat-cafe/shared';
import type { SelfFacetDeps } from './self-facet.js';

/**
 * F300 -- bind the injected sources of `buildSelfFacet` to what this process
 * actually knows.
 *
 * The API is the daemon, so its own identity needs no file read and no `ps`:
 * pid, cwd and the port it is listening on are first-hand facts. Everything
 * else stays someone else's fact behind a resolver.
 */

export interface SelfFacetRuntimeOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly apiPort?: number;
  readonly invocation: { readonly threadId?: string; readonly invocationId?: string; readonly catId: string };
  /** The revision of the artifact this process is executing, as captured at startup. */
  readonly runningRevision?: () => string | undefined;
  /** The revision on disk. Proves the checkout, never the running process. */
  readonly gitHead: () => string | Promise<string>;
  readonly now?: () => number;
}

/**
 * Which revision to report, and what it is the revision of.
 *
 * The running instance's own record comes first: it is the only reading that
 * survives somebody syncing the source without restarting. The checkout is a
 * labelled fallback, not a substitute -- it says "this is what is on disk", and
 * the caller can see that it does. When neither can be read, the answer is
 * `unknown`. An earlier version returned an empty string here, which read as a
 * revision and proved nothing.
 */
async function resolveRevision(
  runningRevision: (() => string | undefined) | undefined,
  gitHead: () => string | Promise<string>,
): Promise<RuntimeRevision> {
  const running = runningRevision?.();
  if (running) return { revision: running, source: 'running' };
  const checkout = (await gitHead())?.trim();
  if (checkout) return { revision: checkout, source: 'checkout' };
  return 'unknown';
}

export function selfFacetSourcesFromRuntime(options: SelfFacetRuntimeOptions): SelfFacetDeps {
  const { env, apiPort, invocation, gitHead, runningRevision } = options;
  const projectRoot = env['CAT_CAFE_RUNTIME_ROOT'] ?? process.cwd();
  const deploymentId = env['CAT_CAFE_DEPLOYMENT_ID'];
  const sourceRef = deploymentId ? `daemon-state:${projectRoot}#${deploymentId}` : `process:${process.pid}#cwd`;

  return {
    installation: () => ({
      projectRoot,
      ...(deploymentId ? { deploymentId } : {}),
      sourceRef,
    }),
    runtimeStatus: async () => ({
      // The same resolved root the installation reports. The launcher `cd`s into
      // `packages/api` before starting us (`start-dev.sh:990-992`), so
      // `process.cwd()` is not the checkout -- reading it here gave one facet two
      // different answers to "where do I live", and the self-host guard compares
      // both of them against what a command would delete.
      worktree: projectRoot,
      head: await resolveRevision(runningRevision, gitHead),
      apiPid: process.pid,
      ...(apiPort ? { apiPort } : {}),
      sourceRef,
    }),
    platform: () => ({
      os: process.platform as HostPlatform,
      arch: process.arch,
      hostNodeId: env['CAT_CAFE_HOST_NODE_ID'] ?? hostname(),
      sourceRef: `process:${process.pid}#platform`,
    }),
    hostDependencies: () => redisDependency(env),
    invocation,
    // The invocation -> account -> pool chain is not established by any owner
    // today: quota summaries are per platform with no account attached, and a
    // cat's client says nothing about which account it runs under. Reporting a
    // platform reading here would be attributing someone else's pool to this cat.
    quota: () => 'unknown',
    ...(options.now ? { now: options.now } : {}),
  };
}

/**
 * Redis is a host dependency in the literal sense -- losing it ends every cat's
 * session -- so it is listed when, and only when, we can name its port.
 */
function redisDependency(env: NodeJS.ProcessEnv): HostDependency[] {
  const url = env['REDIS_URL'];
  const port = url ? Number.parseInt(new URL(url).port, 10) : Number.NaN;
  if (!Number.isInteger(port)) return [];
  return [{ kind: 'redis', port, identityRef: `redis://127.0.0.1:${port}` }];
}
