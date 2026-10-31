import { executedInvocations } from './lib/shell-invocation.mjs';
import { shellInvocation, stripHarmlessRedirections } from './native-effect-shell-tokenizer.mjs';

const FORCE = new Set(['--force', '-f', '--update-head-ok', '-u']);
const VALUES = new Set(['--depth', '--deepen', '--jobs', '-j', '--shallow-since', '--shallow-exclude', '--filter']);
const FLAGS = new Set([
  '--quiet',
  '-q',
  '--verbose',
  '-v',
  '--no-tags',
  '--tags',
  '-t',
  '--prune',
  '-p',
  '--prune-tags',
  '--atomic',
  '--no-write-fetch-head',
  '--append',
  '-a',
  '--all',
  '--multiple',
  '--unshallow',
  '--dry-run',
  '-n',
  '--no-recurse-submodules',
  '--progress',
  '--no-progress',
  '--no-auto-gc',
  '--auto-gc',
  '--refetch',
  '-4',
  '-6',
  '--ipv4',
  '--ipv6',
]);

/** Fetch reads source refs and writes destination refs. Unknown ref-mapping/executing options stay unresolved. */
export function fetchRefRoles(args) {
  if (args?.[0] !== 'fetch') return null;
  const positional = [];
  let forced = false,
    options = true;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (options && token.startsWith('-')) {
      const flag = token.split('=', 1)[0];
      if (FORCE.has(flag)) forced = true;
      else if (VALUES.has(flag)) {
        if (!token.includes('=') && args[++index] === undefined) return null;
      } else if (!FLAGS.has(flag)) return null;
      continue;
    }
    positional.push(token);
  }
  const destinations = [];
  for (const refspec of positional.slice(1)) {
    if (refspec.startsWith('+')) forced = true;
    const colon = refspec.indexOf(':');
    if (colon >= 0) destinations.push(refspec.slice(colon + 1));
  }
  return { destinations, refresh: !forced && destinations.every((ref) => ref.startsWith('refs/remotes/')) };
}

export function fetchTargetText(raw) {
  const parsed = shellInvocation(stripHarmlessRedirections(raw));
  if (!parsed.complete || parsed.redirections.length) return null;
  // Narrow refspecs only after the caller has kept the execution coordinate.
  // Unwrapping env/sudo or dropping Git selectors here would replace a real
  // protected cwd with the caller's ordinary cwd. Keep their original evidence.
  if (parsed.words[0]?.value !== 'git' || parsed.words[1]?.value !== 'fetch') return null;
  const execution = executedInvocations(stripHarmlessRedirections(raw));
  const commands = execution.pipelines.flat();
  if (!execution.complete || commands.length !== 1 || commands[0].name !== 'git') return null;
  const roles = fetchRefRoles(commands[0].operands);
  return roles ? `git fetch ${roles.destinations.map((ref) => JSON.stringify(ref)).join(' ')}` : null;
}
