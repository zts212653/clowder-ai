import { existsSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { executedInvocations } from './lib/shell-invocation.mjs';
import { shellSubstitutions } from './lib/shell-lexical.mjs';
import { programTokens } from './lib/shell-program-tokens.mjs';
import { SUBSTITUTION, splitCommandLines, splitPipelineStages } from './lib/shell-text.mjs';
import { sshConfigurationScope, sshOptionIsLocal } from './lib/ssh-configuration-scope.mjs';
import { separateHereDocuments } from './native-effect-heredoc.mjs';
import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

const OPTIONS = new Set([
  'identitiesonly',
  'batchmode',
  'stricthostkeychecking',
  'connecttimeout',
  'connectionattempts',
  'serveraliveinterval',
  'serveralivecountmax',
  'loglevel',
  'compression',
  'preferredauthentications',
  'passwordauthentication',
  'pubkeyauthentication',
  'requesttty',
]);
const FLAGS = new Set(['-T', '-t', '-n', '-q', '-v', '-vv', '-vvv', '-4', '-C']);

// Detection must precede the narrow remote proof: an unmodelled SSH carrier is
// not a non-SSH command. Reuse execution roles, never search quoted data for ssh.
function containsSshExecution(raw, cwd, depth = 0) {
  if (depth > 8) return false;
  const graph = executedInvocations(raw, { cwd });
  const calls = graph.pipelines.flat();
  if (calls.some((call) => call.wrappers?.some((wrapper) => commandName(wrapper.program) === 'ssh'))) return true;
  for (const source of [raw, ...graph.unresolvedEvidence])
    for (const line of splitCommandLines(source, { groups: true }))
      for (const stage of splitPipelineStages(line)) {
        const tokens = shellInvocation(stage).words.map((word) => word.value);
        const program = programTokens(tokens, cwd);
        if (program.wrappers.some((wrapper) => commandName(wrapper.program) === 'ssh')) return true;
      }
  return shellSubstitutions(raw, SUBSTITUTION).inner.some((source) => containsSshExecution(source, cwd, depth + 1));
}

function systemSsh(program, cwd) {
  const path =
    program === 'ssh'
      ? (process.env.PATH ?? '')
          .split(delimiter)
          .map((p) => resolve(cwd ?? '.', p, 'ssh'))
          .find(existsSync)
      : program;
  try {
    return realpathSync(path) === realpathSync('/usr/bin/ssh');
  } catch {
    return false;
  }
}

function remoteAddress(host, addresses) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return false;
  return !addresses.includes(host);
}

function optionEffect(name, value) {
  if (name === '-i') return {}; // Local read input; never a write or service target.
  if (name === '-p' && /^\d+$/.test(value) && +value > 0 && +value <= 65535) return { port: +value };
  if (name === '-l' && /^[\w.-]+$/.test(value)) return { user: value };
  if (name !== '-o') return null;
  const option = /^([A-Za-z]+)(?:=|\s+)(.+)$/s.exec(value);
  if (!option) return null;
  if (sshOptionIsLocal(option[1], option[2])) return { unproven: true };
  return OPTIONS.has(option[1].toLowerCase()) && !/[\r\n]/.test(option[2]) ? {} : null;
}

function readTransportOption(words, index) {
  const flag = words[index++].value;
  if (FLAGS.has(flag)) return { next: index };
  if (flag === '--') return { next: index, end: true };
  const attached = /^-[iplo].+/.test(flag);
  const name = attached ? flag.slice(0, 2) : flag;
  const value = attached ? flag.slice(2) : words[index++]?.value;
  const effect = value === undefined ? null : optionEffect(name, value);
  return effect ? { ...effect, next: index } : null;
}

function transport(words, localAddresses) {
  let index = 1;
  const state = {};
  while (index < words.length && words[index].value.startsWith('-')) {
    const option = readTransportOption(words, index);
    if (!option || option.unproven) return option;
    index = option.next;
    Object.assign(state, option);
    if (option.end) break;
  }
  const destination = /^(?:([\w.-]+)@)?([A-Za-z0-9.:-]+)$/.exec(words[index++]?.value ?? '');
  if (!destination || index >= words.length) return null;
  // OpenSSH resumes option parsing after the destination. This proof admits
  // only a non-option command there; it must not hide -o/-F/-J as remote argv.
  if (words[index].value.startsWith('-')) return { unproven: true };
  if (state.user && destination[1] && state.user !== destination[1]) return null;
  return {
    host: destination[2],
    user: state.user ?? destination[1],
    port: state.port,
    remote: remoteAddress(destination[2], localAddresses),
    command: words
      .slice(index)
      .map((word) => word.value)
      .join(' '),
  };
}

/** A single literal SSH transport owns its remote argv and quoted stdin.
 * Everything the local shell executes/redirects stays outside that namespace.
 * Every detected but unmodelled SSH execution is unproven, never a null escape
 * into the old argv-wrapper reader. No SSH connection occurs.
 */
export function remoteSshExecution(raw, cwd, options = {}) {
  const layout = separateHereDocuments(raw);
  const command = (layout?.text ?? raw).trim();
  const parsed = shellInvocation(command);
  const program = parsed.words[0]?.value;
  if (commandName(program) !== 'ssh') return containsSshExecution(command, cwd) ? { unproven: true } : null;
  if (
    !layout ||
    layout.heredocs.length > 1 ||
    layout.heredocs.some((h) => !h.quoted) ||
    !parsed.syntaxComplete ||
    !parsed.words.every((w) => w.literal) ||
    !parsed.redirections.every((r) => r.operand.literal)
  )
    return { unproven: true };
  if (!['ssh', '/usr/bin/ssh'].includes(program) || !systemSsh(program, cwd)) return { unproven: true };
  const localAddresses =
    options.localAddresses ??
    Object.values(networkInterfaces())
      .flat()
      .filter(Boolean)
      .map((a) => a.address);
  const target = transport(parsed.words, localAddresses);
  if (!target) return { unproven: true };
  if (target.unproven) return target;
  const configuration = sshConfigurationScope(target.host, options.configFiles);
  if (!configuration.complete) return { unproven: true };
  if (!target.remote) {
    // SSH joins the remote argv into shell source. For a local or unproved
    // destination, inspect that source under local protection, not as one
    // opaque executable name ("kill -TERM PID" is not a program name).
    return {
      local: `${target.command} ${parsed.redirections.map((r) => command.slice(r.start, r.end)).join(' ')}\n${layout.heredocs.map((h) => h.span).join('')}`,
    };
  }
  const redirects = parsed.redirections.filter((r) => !/^\d*<<-?$/.test(r.operator));
  // Preserve the shell's exact redirection operands and their ordering. The
  // opaque remote command is not re-parsed as local source or certified read.
  const local = `: ${redirects.map((r) => command.slice(r.start, r.end)).join(' ')}`;
  const port = target.port ?? configuration.port;
  return { local, target: `ssh://${target.user ? `${target.user}@` : ''}${target.host}:${port}` };
}
