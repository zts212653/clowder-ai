import { resolve } from 'node:path';

import {
  classifyShellSegment,
  destructiveInvocationEffect,
  splitShellExecutionSegments,
} from '../native-effect-shell-classifier.mjs';
import { classifyNativeTarget } from '../native-effect-target-classifier.mjs';
import { analyseCommands } from './self-host-targets.mjs';
import { executedInvocations, optionValue } from './shell-invocation.mjs';

/**
 * F300 Task 1.2 -- "would this command stop me?"
 *
 * The existing native effect/target guard answers "is this target protected".
 * It cannot answer this one, because the answer is not static: which pid, which
 * port and which deployment are *us* changes per invocation. So the self facet
 * is an injected input and this module stays a pure function -- fixtures in,
 * verdict out, no signal ever sent to prove the point (KD-14, C0/C5).
 *
 * Target classification (what counts as sanctuary) is delegated to the existing
 * classifier rather than restated here; a second copy would drift the day
 * someone adds a protected path. Which targets a command names is delegated to
 * `self-host-targets.mjs`, so parsing and policy stay separable.
 */

function uniq(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function selfPorts(self) {
  return uniq([self.runtime?.apiPort, ...(self.hostDependencies ?? []).map((dependency) => dependency.port)]);
}

function selfPids(self) {
  return uniq([
    self.runtime?.apiPid,
    self.runtime?.launcherPid,
    ...(self.launcherPids ?? []),
    ...(self.hostDependencies ?? []).flatMap((dependency) => [dependency.pid, ...(dependency.pids ?? [])]),
  ]);
}

/**
 * INV-7: protect dependencies and their ancestors, not their descendants.
 * A feature server spawned by a CLI is downstream of the host API, but the
 * host does not depend on that feature server. All observations are injected;
 * a listener/ancestry lookup failure remains unknown, never permission.
 */
function targetsHostDependencies(pids, self, { isHostDescendant, readHostPids, observerPid }) {
  if (!isHostDescendant) return { hit: false, unknownFacts: [] };
  const observed = readHostPids?.() ?? { pids: [], complete: selfPorts(self).length === 0 };
  const dependencies = uniq([...selfPids(self), ...observed.pids, observerPid]);
  const unknownFacts = observed.complete ? [] : ['listener ownership'];
  for (const pid of pids) {
    for (const dependency of dependencies) {
      const answer = isHostDescendant(dependency, pid);
      if (answer === true) return { hit: true, unknownFacts: [] };
      if (answer === undefined) unknownFacts.push(`ancestor chain for pid ${dependency}`);
    }
  }
  return { hit: false, unknownFacts: uniq(unknownFacts) };
}

function identityRefFor(self, { pid, port }) {
  const dependency = (self.hostDependencies ?? []).find(
    (candidate) =>
      (pid !== undefined && (candidate.pid === pid || candidate.pids?.includes(pid))) ||
      (port !== undefined && candidate.port === port),
  );
  return dependency?.identityRef ?? self.runtime?.sourceRef ?? self.installation?.sourceRef ?? 'self';
}

function assessment(verdict, reason, matchedTargets = [], sourceRefs = []) {
  return { verdict, reason, matchedTargets: uniq(matchedTargets), sourceRefs: uniq(sourceRefs) };
}

const ELSEWHERE =
  'If you need a runtime to poke at, use the isolated alpha stack (Redis 6397); if production really has to stop, ask You.';

/** Sanctuary is the existing classifier's answer, not a second opinion. */
function sanctuaryHit(raw, cwd) {
  return splitShellExecutionSegments(raw)
    .map((segment) => ({ segment, effect: classifyShellSegment(segment) }))
    .filter(({ effect }) => ['process_control', 'service_mutation', 'delete', 'repository_rewrite'].includes(effect))
    .map(({ segment, effect }) => classifyNativeTarget(segment, cwd, effect))
    .find((target) => target.kind === 'runtime_sanctuary' || target.kind === 'redis_sanctuary');
}

/** Programs whose non-flag operands are the paths they act on. */
const PATH_OPERAND_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash']);

/**
 * Resolve a target the way the shell would, against the cwd it runs in.
 *
 * Normalisation is the point, not convenience: `../cat-cafe-f300/packages/api`
 * and `node_modules/../packages/api` name our source tree, and comparing
 * un-normalised strings gets both directions wrong -- letting a traversal in
 * while refusing a sibling path that merely starts with the same characters.
 */
function resolveTarget(path, cwd) {
  if (path.startsWith('/')) return resolve(path);
  if (!cwd) return undefined; // Without a cwd a relative path names nothing we can compare.
  return resolve(cwd, path);
}

/** Is this resolved path our own checkout, or content inside it? */
function insideSelf(path, roots) {
  return roots.some((candidate) => {
    const root = resolve(candidate);
    return path === root || path.startsWith(`${root}/`);
  });
}

/**
 * The paths a destructive invocation would actually act on.
 *
 * Taken from the parsed operands rather than scanned out of the raw text: a
 * path mentioned in a message or in an unrelated argument is not a target, and
 * a relative path is one. Programs that name no path act where they stand --
 * `git reset --hard` rewrites the checkout the shell is sitting in.
 */
function destructiveTargets(invocation, cwd) {
  const operands = invocation.operands.filter((token) => !token.startsWith('-'));
  if (PATH_OPERAND_PROGRAMS.has(invocation.name ?? '')) return operands;
  if (invocation.name === 'git') {
    const directory = optionValue(invocation.operands, '-C') ?? cwd;
    return directory ? [directory] : [];
  }
  return cwd ? [cwd] : [];
}

function destructiveSelfPaths(raw, cwd, self) {
  const roots = uniq([self.installation?.projectRoot, self.runtime?.worktree]);
  if (roots.length === 0) return [];
  const hits = [];
  for (const invocation of executedInvocations(raw, { cwd }).pipelines.flat()) {
    // The canonical module's argv answer, not its text answer. Stage text reads
    // `env -C dir rm -rf x` as `unknown` (the wrapper hides the delete) and
    // `echo git reset --hard` as a rewrite (the words are simply there); the
    // argv answer anchors on the program, and for Git on its subcommand.
    if (!destructiveInvocationEffect(invocation)) continue;
    // A wrapper may have moved this invocation's coordinate; its relative
    // targets resolve where *it* runs, not where the outer command was typed.
    const here = invocation.cwd ?? cwd;
    for (const target of destructiveTargets(invocation, here)) {
      const resolved = resolveTarget(target, here);
      if (resolved && insideSelf(resolved, roots)) hits.push(resolved);
    }
  }
  return uniq(hits);
}

/**
 * Does this command line stop the deployment hosting us?
 *
 * A deployment is ours when its id matches and its root either matches or was
 * never named. An explicitly different root is somebody else's deployment, and
 * refusing that would be a refusal we cannot justify.
 */
function stopsOwnDeployment(deployment, self) {
  if (!deployment) return false;
  const ownId = self.installation?.deploymentId;
  const ownRoot = self.installation?.projectRoot;
  if (deployment.deploymentId !== undefined) {
    if (deployment.deploymentId !== ownId) return false;
    return deployment.projectRoot === undefined || deployment.projectRoot === ownRoot;
  }
  if (deployment.projectRoot === undefined) return false;
  return deployment.projectRoot === ownRoot || String(deployment.projectRoot).startsWith(`${ownRoot}/`);
}

export function assessSideEffect(commandLine, cwd, self = {}, observations = {}) {
  const raw = String(commandLine ?? '');
  if (!raw.trim()) return assessment('allow', 'Nothing to assess.');

  const sanctuary = sanctuaryHit(raw, cwd);
  if (sanctuary) {
    return assessment(
      'sanctuary',
      `This would mutate the sanctuary target ${sanctuary.value}, which is You's, not ours. ${ELSEWHERE}`,
      [sanctuary.value],
      [sanctuary.value],
    );
  }

  const commands = analyseCommands(raw, cwd);
  const knownPids = selfPids(self);
  const knownPorts = selfPorts(self);

  for (const command of commands) {
    if (!command.stopClass) continue;
    // Every deployment this command stops, not the first one found: an
    // unrelated deployment ahead of ours is not evidence about ours.
    if (command.deployments.some((deployment) => stopsOwnDeployment(deployment, self))) {
      const ref = self.installation?.sourceRef ?? 'self';
      return assessment(
        'self_host',
        `"${command.text}" stops the deployment hosting this cat right now -- running it would end this session mid-turn. ${ELSEWHERE}`,
        [ref],
        [ref],
      );
    }
    const pidHits = command.pids.filter((pid) => knownPids.includes(pid));
    const portHits = command.ports.filter((port) => knownPorts.includes(port));
    if (pidHits.length > 0 || portHits.length > 0) {
      const refs = [
        ...pidHits.map((pid) => identityRefFor(self, { pid })),
        ...portHits.map((port) => identityRefFor(self, { port })),
      ];
      const named = pidHits.length > 0 ? `pid ${pidHits.join(', ')}` : `port ${portHits.join(', ')}`;
      return assessment(
        'self_host',
        `"${command.text}" targets ${named}, which is a process this cat is running inside of -- running it would end this session mid-turn. ${ELSEWHERE}`,
        refs,
        refs,
      );
    }

    // Recorded ports resolve the actual services; reverse ancestry protects
    // their wrappers and this invocation, without protecting every descendant.
    const unrecognised = command.pids.filter((pid) => !knownPids.includes(pid));
    if (unrecognised.length > 0) {
      const dependency = targetsHostDependencies(unrecognised, self, observations);
      const ref = self.runtime?.sourceRef ?? 'self';
      if (dependency.hit) {
        return assessment(
          'self_host',
          `"${command.text}" targets a host dependency or an ancestor of a host service or the current executor -- stopping it would interrupt this session. ${ELSEWHERE}`,
          [ref],
          [ref],
        );
      }
      if (dependency.unknownFacts.length > 0) {
        return assessment(
          'unknown',
          `"${command.text}" cannot be ruled out as a host dependency: unreadable ${dependency.unknownFacts.join(', ')}. ${ELSEWHERE}`,
        );
      }
    }
  }

  const deletesSelf = destructiveSelfPaths(raw, cwd, self);
  if (deletesSelf.length > 0) {
    const ref = self.runtime?.sourceRef ?? 'self';
    return assessment(
      'self_host',
      `This would delete or rewrite ${deletesSelf[0]}, which is inside the checkout this cat is running out of. ${ELSEWHERE}`,
      [ref],
      [ref],
    );
  }

  const unresolved = commands.find((command) => command.stopClass && command.unresolved);
  if (unresolved) {
    return assessment(
      'unknown',
      `"${unresolved.text}" stops something, but its target set cannot be read from the command, so it cannot be shown not to be us. Name the exact pid or port -- run \`pgrep\` first if you need to -- or run it against the alpha stack. ${ELSEWHERE}`,
    );
  }

  // Nothing here stops anything we can be, and every stop named a target we could read.
  if (knownPids.length === 0 && knownPorts.length === 0 && commands.some((command) => command.stopClass)) {
    return assessment(
      'unknown',
      `This stops a process, but the home state cannot say which processes are hosting this cat, so it cannot rule out that this is us. ${ELSEWHERE}`,
    );
  }

  return assessment('allow', 'Nothing here stops a local process or service that this cat runs inside of.');
}
