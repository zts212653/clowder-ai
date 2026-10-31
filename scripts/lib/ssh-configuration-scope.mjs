import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { shellWords, stripShellComments } from '../native-effect-shell-tokenizer.mjs';

// These options can execute locally, relocate the connection, reuse another
// transport, or introduce local listeners/writes. They are never a remote proof.
const LOCAL_OPTIONS = new Set([
  'proxycommand',
  'proxyjump',
  'localcommand',
  'permitlocalcommand',
  'knownhostscommand',
  'remotecommand',
  'localforward',
  'remoteforward',
  'dynamicforward',
  'tunnel',
  'tunneldevice',
  'controlmaster',
  'controlpath',
  'pkcs11provider',
  'securitykeyprovider',
  'canonicalizehostname',
  'canonicaldomains',
  'userknownhostsfile',
  'globalknownhostsfile',
  'updatehostkeys',
]);
// Values are option-specific: `ProxyCommand no` names a local executable;
// it is not the boolean spelling used by PermitLocalCommand.
const DISABLED = new Map([
  ['proxycommand', new Set(['none'])],
  ['proxyjump', new Set(['none'])],
  ['permitlocalcommand', new Set(['no'])],
  ['controlmaster', new Set(['no'])],
  ['controlpath', new Set(['none'])],
  ['canonicalizehostname', new Set(['no'])],
  ['updatehostkeys', new Set(['no'])],
  ['tunnel', new Set(['no'])],
]);

export function sshOptionIsLocal(name, value) {
  name = name.toLowerCase();
  return LOCAL_OPTIONS.has(name) && !DISABLED.get(name)?.has(value.toLowerCase());
}

function globPattern(pattern) {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
    'i',
  );
}

function hostMatches(patterns, host) {
  let positive = false;
  for (const pattern of patterns) {
    // systemd uses unix/* and unix%* Host patterns for its local transports.
    // Slash and percent are literal pattern data here, never an executable or
    // a token expansion. Match first; only the active block's options apply.
    if (!/^[!\w.*?:%/-]+$/.test(pattern)) throw new Error('unreadable SSH Host pattern');
    const negative = pattern.startsWith('!');
    if (!globPattern(negative ? pattern.slice(1) : pattern).test(host)) continue;
    if (negative) return false;
    positive = true;
  }
  return positive;
}

function includePaths(value, prefix) {
  const path = value.startsWith('~/')
    ? join(homedir(), value.slice(2))
    : isAbsolute(value)
      ? value
      : join(prefix, value);
  if (/[$%`{}[\]]/.test(path) || /[*?]/.test(dirname(path))) throw new Error('unreadable SSH Include');
  if (!/[*?]/.test(path)) return [path];
  let names;
  try {
    names = readdirSync(dirname(path));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (names.length > 256) throw new Error('SSH Include exceeds bound');
  return names
    .filter((name) => globPattern(basename(path)).test(name))
    .sort()
    .map((name) => join(dirname(path), name));
}

function configurationBytes(path) {
  let fd;
  try {
    fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('SSH config is not a bounded ordinary file');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 65536) throw new Error('SSH config grew beyond its bound');
    return buffer.toString('utf8', 0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read configuration, never `ssh -G`: Match exec can run even during that query.
 * This recognizes Host/Include only; unmodelled Match or relocation is unknown.
 * All files remain inputs; no identity contents or SSH command is read/executed.
 */
function auditOption(key, value, state) {
  if (sshOptionIsLocal(key, value) || (key === 'hostname' && value !== state.host))
    throw new Error('SSH config changes local execution/target');
  if (key !== 'port' || state.port !== undefined) return;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('SSH port is unknown');
  state.port = Number(value);
}

function readDirective(words, context, prefix, depth, state) {
  const key = words[0].value.toLowerCase();
  const values = words.slice(1).map((word) => word.value);
  if (key === 'host') {
    context.active = hostMatches(values, state.host);
    return;
  }
  if (key === 'match') throw new Error('SSH Match execution scope is unknown');
  if (!context.active) return;
  if (key !== 'include') {
    auditOption(key, values.join(' '), state);
    return;
  }
  // Host state inside an Include is local to that file. Options remain
  // shared, but its last Host block must not disable the parent's checks.
  for (const value of values)
    for (const file of includePaths(value, prefix)) readConfiguration(file, { ...context }, prefix, depth + 1, state);
}

function readConfiguration(path, context, prefix, depth, state) {
  if (depth > 4 || state.visited.has(path) || state.visited.size >= 16) throw new Error('SSH config recursion');
  state.visited.add(path);
  const source = configurationBytes(path);
  state.bytes += Buffer.byteLength(source);
  if (state.bytes > 262144) throw new Error('SSH config exceeds bound');
  for (const line of source.split(/\r?\n/)) {
    const text = stripShellComments(line).trim();
    if (!text) continue;
    const words = shellWords(text.replace(/^(\w+)\s*=\s*/, '$1 '));
    if (!words?.length) throw new Error('unreadable SSH config');
    readDirective(words, context, prefix, depth, state);
  }
}

export function sshConfigurationScope(host, files = [join(homedir(), '.ssh/config'), '/etc/ssh/ssh_config']) {
  const state = { host, visited: new Set(), bytes: 0, port: undefined };
  try {
    for (const file of files) readConfiguration(file, { active: true }, dirname(file), 0, state);
    return { complete: true, port: state.port ?? 22 };
  } catch (error) {
    return { complete: false, reason: error.code ?? error.message };
  }
}
