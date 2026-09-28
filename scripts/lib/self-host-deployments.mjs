import { resolve } from 'node:path';

import { optionValue, unquote } from './shell-invocation.mjs';

/**
 * F300 -- which deployment a command line stops, when it says so by name.
 *
 * Named lifecycles are the one case where a command can stop us without ever
 * mentioning a pid or a port. They are judged from the parsed invocations
 * `shell-invocation.mjs` produced, never from the text: a lifecycle name only
 * counts when it is the script an executor was actually asked to run, and it
 * counts wherever that executor sits -- second in a pipeline, inside a shell
 * string, behind `sudo`.
 */

/** Package managers where the lifecycle name is an operand, not the program. */
const SCRIPT_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
/** Runner options whose value is a separate token, so it is not the script name. */
const RUNNER_VALUE_OPTIONS = new Set(['--filter', '-C', '--dir', '--prefix', '--workspace', '-w']);

const NAMED_DEPLOYMENT_SCRIPTS = new Map([
  ['runtime:stop', 'runtime'],
  ['runtime:restart', 'runtime'],
  ['alpha:stop', 'alpha'],
]);
/** `pnpm stop` / `dev:stop` act on the installation the command runs against. */
const CWD_SCOPED_SCRIPTS = new Set(['stop', 'dev:stop']);
const WORKTREE_SCRIPTS = new Map([
  ['runtime-worktree.sh', { deploymentId: 'runtime', subcommands: new Set(['stop', 'restart']) }],
  ['alpha-worktree.sh', { deploymentId: 'alpha', subcommands: new Set(['stop']) }],
]);
/** Package managers can be pointed at another checkout, which moves the target with them. */
const DIRECTORY_OPTIONS = ['--dir', '--prefix', '-C'];

/**
 * Where this runner was pointed, resolved against where it runs.
 *
 * Read from the invocation's own operands, never from the surrounding text: in
 * `env -C /elsewhere pnpm --dir /host stop` a scan of the whole stage picks up
 * the wrapper's `-C` and hides the `--dir` that actually selects the target.
 */
function runnerDirectory(operands, cwd) {
  for (const option of DIRECTORY_OPTIONS) {
    const value = unquote(optionValue(operands, option));
    if (value === undefined) continue;
    // Resolved and normalised here, like every other coordinate: a `..` left in
    // the string makes the comparison against our root wrong in both
    // directions -- letting a traversal in, and refusing a sibling on its way out.
    if (value.startsWith('/')) return resolve(value);
    return cwd ? resolve(cwd, value) : undefined;
  }
  return cwd;
}

/** The script name a package manager was asked to run, skipping its own options. */
function runnerScript(operands) {
  for (let index = 0; index < operands.length; index++) {
    const token = operands[index];
    if (RUNNER_VALUE_OPTIONS.has(token)) {
      index += 1; // The value is this option's, not the script name.
      continue;
    }
    if (token.startsWith('-')) continue; // `--filter=x`, bare flags.
    if (token === 'run' || token === 'exec') continue;
    return token;
  }
  return undefined;
}

/**
 * Which deployment this single invocation stops, or `undefined` for none.
 *
 * The canonical CLI's subcommand is the first operand after the script, and
 * only `stop` stops anything -- `stop-reverify` reports on a recovery that
 * already happened, and refusing it would block the very chain this feature
 * added.
 */
function deploymentOf({ name, operands }, cwd) {
  if (name === 'daemon-state.mjs') {
    const subcommand = operands.find((token) => !token.startsWith('-'));
    if (subcommand !== 'stop') return undefined;
    return {
      deploymentId: optionValue(operands, '--deployment-id'),
      projectRoot: optionValue(operands, '--project-root') ?? undefined,
    };
  }

  const worktreeScript = WORKTREE_SCRIPTS.get(name ?? '');
  if (worktreeScript) {
    const subcommand = operands.find((token) => !token.startsWith('-'));
    return worktreeScript.subcommands.has(subcommand ?? '') ? { deploymentId: worktreeScript.deploymentId } : undefined;
  }

  if (name === 'start-dev.sh') {
    return operands.includes('--stop') ? { projectRoot: runnerDirectory(operands, cwd) } : undefined;
  }

  if (!SCRIPT_RUNNERS.has(name ?? '')) return undefined;
  const script = runnerScript(operands);
  if (script === undefined) return undefined;
  const deploymentId = NAMED_DEPLOYMENT_SCRIPTS.get(script);
  if (deploymentId) return { deploymentId };
  if (!CWD_SCOPED_SCRIPTS.has(script)) return undefined;
  return { projectRoot: runnerDirectory(operands, cwd) };
}

/**
 * Every named deployment these invocations would stop.
 *
 * All of them, not the first: `pnpm alpha:stop | pnpm runtime:stop` stops two,
 * and finding a deployment that is not ours proves nothing about the next one.
 *
 * @returns {{deploymentId?: string, projectRoot?: string}[]}
 */
export function stoppedDeploymentsIn(invocations, cwd) {
  return invocations
    .map((invocation) => deploymentOf(invocation, invocation.cwd ?? cwd))
    .filter((stopped) => stopped !== undefined);
}
