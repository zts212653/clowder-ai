import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daemonStatePaths } from './daemon-state.mjs';

/**
 * F300 Task 1.3 -- resolve "what is hosting me" cheaply enough to run on every
 * tool call.
 *
 * Two things this must not get wrong.
 *
 * First, where to read. The daemon state path is computed by `daemonStatePaths`
 * from the project root, and the launch scripts write through it. Re-deriving
 * that path here once produced a reader that looked in a different directory
 * than the writer wrote to, and a reader that finds nothing reports "nothing is
 * hosting me" -- which reads as permission to stop things.
 *
 * Second, what "not found" means. No deployment named at all, a named deployment
 * whose record cannot be read, and several candidate records are three different
 * situations. Only the first one means we are unhosted. The other two are
 * missing evidence, and missing evidence is not a licence.
 *
 * It reads files and nothing else: no `ps`, no port probe, no API call, because
 * this runs inside a PreToolUse hook with a five second budget.
 */

/** @returns {{confidence: 'exact'|'ambiguous'|'unreadable'|'none', facet?: object}} */
export function readSelfHostFacet({ env = process.env, homeDir = homedir(), now = () => Date.now() } = {}) {
  const deploymentId = env.CAT_CAFE_DEPLOYMENT_ID;
  // Nothing claims to host us. This is the only genuinely unhosted case.
  if (!deploymentId) return { confidence: 'none' };

  const projectRoot = env.CAT_CAFE_RUNTIME_ROOT;
  const states = readDaemonStates({ homeDir, deploymentId, projectRoot });

  // A deployment is named but we cannot read its record: fail closed rather than
  // claim the absence of evidence is evidence of absence.
  if (states.length === 0) {
    return { confidence: 'unreadable', facet: unresolvedFacet(deploymentId, projectRoot, env, now()) };
  }

  const preferred = states.find((state) => state.projectRoot === projectRoot) ?? states[0];
  const confidence = states.length === 1 || preferred.projectRoot === projectRoot ? 'exact' : 'ambiguous';
  // Every candidate stays in the facet. Until a candidate is ruled out, a target
  // that matches it has not been shown to be someone else's.
  return { confidence, facet: facetFromDaemonStates(preferred, states, deploymentId, env, now()) };
}

/**
 * When the environment names our root, that root is the question. Another
 * deployment's record cannot answer it: an earlier draft fell back to scanning
 * every deployment and then labelled the single foreign candidate `exact`,
 * which silently reassigned "me" to somebody else's daemon and let a stop
 * against our own port through.
 */
function readDaemonStates({ homeDir, deploymentId, projectRoot }) {
  if (projectRoot) {
    const state = readOneState(canonicalStateFile({ homeDir, projectRoot, deploymentId }), deploymentId);
    return state ? [state] : [];
  }
  const daemonsDir = join(homeDir, '.cat-cafe', 'daemons');
  if (!existsSync(daemonsDir)) return [];
  const states = [];
  for (const entry of readdirSync(daemonsDir)) {
    if (!entry.startsWith(`${deploymentId}-`)) continue;
    const state = readOneState(join(daemonsDir, entry, 'daemon.json'), deploymentId);
    if (state) states.push(state);
  }
  return states;
}

/** Ask the canonical writer where the record lives instead of rebuilding its layout. */
function canonicalStateFile({ homeDir, projectRoot, deploymentId }) {
  try {
    return daemonStatePaths({ homeDir, projectRoot, deploymentId }).stateFile;
  } catch {
    return undefined;
  }
}

function readOneState(stateFile, deploymentId) {
  if (!stateFile || !existsSync(stateFile)) return undefined;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (state?.deploymentId !== deploymentId || typeof state.projectRoot !== 'string') return undefined;
    return { ...state, stateFile };
  } catch {
    // A malformed record is not evidence of anything; it must not decide a
    // security question in either direction.
    return undefined;
  }
}

function platformFacet(env, observedAt) {
  return {
    os: process.platform,
    arch: process.arch,
    hostNodeId: env.CAT_CAFE_HOST_NODE_ID ?? 'local',
    observedAt,
    sourceRef: `process:${process.pid}#platform`,
  };
}

function unresolvedFacet(deploymentId, projectRoot, env, observedAt) {
  const sourceRef = `daemon-state:${projectRoot ?? '<unknown-root>'}#${deploymentId}`;
  return {
    v: 1,
    installation: { projectRoot, deploymentId, observedAt, sourceRef },
    runtime: { worktree: projectRoot, head: '', observedAt, sourceRef },
    platform: platformFacet(env, observedAt),
    coordinates: { catId: env.CAT_CAFE_CAT_ID ?? 'unknown' },
    hostDependencies: [],
    heldLeases: [],
    quota: 'unknown',
  };
}

/**
 * The recorded pid is the launcher shell, not the API. The API and the web
 * server are its children and are not recorded anywhere, so they are described
 * by the ports they hold plus the launcher they hang off -- `launcherPid` is
 * what lets a caller ask the ancestry question about an arbitrary pid.
 */
function facetFromDaemonStates(preferred, states, deploymentId, env, observedAt) {
  const sourceRef = `daemon-state:${preferred.projectRoot}#${deploymentId}`;
  const ports = preferred.ports ?? {};

  const hostDependencies = states.flatMap((state) => {
    const ref = `daemon-state:${state.projectRoot}#${deploymentId}`;
    const statePorts = state.ports ?? {};
    return [
      ...(state.pid ? [{ kind: 'daemon', pid: state.pid, identityRef: ref, role: 'launcher' }] : []),
      ...(statePorts.api ? [{ kind: 'api', port: statePorts.api, identityRef: ref }] : []),
      ...(statePorts.frontend ? [{ kind: 'daemon', port: statePorts.frontend, identityRef: ref }] : []),
      ...(statePorts.redis
        ? [{ kind: 'redis', port: statePorts.redis, identityRef: `redis://127.0.0.1:${statePorts.redis}` }]
        : []),
    ];
  });

  return {
    v: 1,
    installation: { projectRoot: preferred.projectRoot, deploymentId, observedAt, sourceRef },
    runtime: {
      worktree: preferred.projectRoot,
      head: '',
      ...(preferred.pid ? { launcherPid: preferred.pid } : {}),
      ...(ports.api ? { apiPort: ports.api } : {}),
      observedAt,
      sourceRef,
    },
    platform: platformFacet(env, observedAt),
    coordinates: { catId: env.CAT_CAFE_CAT_ID ?? 'unknown' },
    /** Every candidate launcher, so an ancestry check can consider all of them. */
    launcherPids: states.map((state) => state.pid).filter(Boolean),
    hostDependencies,
    heldLeases: [],
    quota: 'unknown',
  };
}
