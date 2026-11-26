import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { shellInvocation } from '../native-effect-shell-tokenizer.mjs';
import { kernelPath } from './shell-directory.mjs';

const RECEIVER = '/usr/bin/head';
const MAX_BYTES = 1024 * 1024;

function systemBinaryIdentity(path) {
  try {
    const physical = kernelPath(path);
    if (!physical) return null;
    const stat = lstatSync(physical);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return null;
    return { path: physical, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
  } catch {
    return null;
  }
}

/** One reviewed native operation: bounded stdin-to-stdout copying, with no code/file/endpoint operand. */
export function readAgyDataInputContract(command, cwd) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const parsed = shellInvocation(command);
  if (!parsed.complete || parsed.redirections.length || parsed.words.length !== 4) return null;
  const [replaceShell, receiver, limitFlag, rawLimit] = parsed.words.map((word) => word.value);
  if (replaceShell !== 'exec' || receiver !== RECEIVER || limitFlag !== '-c') return null;
  if (!/^[1-9]\d{0,6}$/.test(rawLimit)) return null;
  const byteLimit = Number(rawLimit);
  if (byteLimit > MAX_BYTES) return null;
  const implementation = systemBinaryIdentity(RECEIVER);
  if (!implementation) return null;
  return { kind: 'bounded_stdin_data', cwd, implementation, byteLimit };
}

export function buildAgyDataReceiverCommand(byteLimit = 9) {
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > MAX_BYTES) return null;
  // Replacing the launcher prevents unread trailing stdin from reaching a shell.
  const command = `exec ${RECEIVER} -c ${byteLimit}`;
  return readAgyDataInputContract(command, process.cwd()) ? command : null;
}
