import { lstatSync, opendirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  commandName,
  stripHarmlessRedirections,
  tokenizeSimpleShellCommand,
} from './native-effect-shell-tokenizer.mjs';

const MEDIA_OBSERVATION_COMMANDS = new Set(['ffprobe']);

export function isLocalMediaObservationCommand(raw) {
  const tokens = tokenizeSimpleShellCommand(stripHarmlessRedirections(raw));
  if (!tokens || tokens.length === 0) return false;
  if (MEDIA_OBSERVATION_COMMANDS.has(commandName(tokens[0]))) return true;
  if (['command', 'sudo'].includes(commandName(tokens[0]))) {
    return MEDIA_OBSERVATION_COMMANDS.has(commandName(tokens[1]));
  }
  if (commandName(tokens[0]) !== 'env') return false;
  return MEDIA_OBSERVATION_COMMANDS.has(commandName(firstEnvCommand(tokens.slice(1))));
}

export function isConstrainedLocalMediaObservation(raw) {
  const tokens = tokenizeSimpleShellCommand(stripHarmlessRedirections(raw));
  if (!tokens) return false;
  if (tokens[0] === 'ffprobe') return isConstrainedFfprobeRead(tokens);
  return false;
}

/** Keep copy read provenance separate from its complete destination namespace. */
export function explicitCopyRoles(raw) {
  const parsed = exactCopyGrammar(raw);
  if (!parsed) return null;
  const { source, destination, recursive } = parsed;
  if (!isAbsoluteSingleFilePath(source) || !isAbsoluteSingleFilePath(destination)) return null;
  const targets = [destination];
  try {
    if (statSync(destination).isDirectory()) targets.push(join(destination, basename(source)));
  } catch (error) {
    if (error.code !== 'ENOENT') return { source, destination, complete: false };
  }
  const physical = targets.map((target) => physicalWriteTarget(target));
  return {
    source,
    destination,
    recursive,
    complete: physical.every(Boolean) && (!recursive || recursiveTargetIsUnique(physical.at(-1))),
    targetText: [...targets, ...physical.filter(Boolean)].map((path) => JSON.stringify(path)).join(' '),
  };
}

/** An exact plain-file copy cannot create or redirect a filesystem alias. */
export function isExactNonRecursiveCopy(raw) {
  const parsed = exactCopyGrammar(raw);
  return Boolean(
    parsed && !parsed.recursive && isLiteralSinglePath(parsed.source) && isLiteralSinglePath(parsed.destination),
  );
}

function exactCopyGrammar(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || tokens[0] !== 'cp') return null;
  let index = 1;
  const recursive = tokens[index] === '-R';
  if (recursive) index += 1;
  if (tokens[index] === '--') index += 1;
  else if (!recursive) return null;
  if (tokens.length - index !== 2) return null;
  const [source, destination] = tokens.slice(index);
  return { source, destination, recursive };
}

function physicalWriteTarget(path, depth = 0) {
  if (depth > 128) return null;
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      return physicalWriteTarget(resolve(dirname(path), readlinkSync(path)), depth + 1);
    }
    // A regular destination with another hard link has no unique physical path:
    // truncating it mutates every alias, including one in a protected checkout.
    if (metadata.isFile() && metadata.nlink > 1) return null;
    return realpathSync.native(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) return null;
    const parent = physicalWriteTarget(dirname(path), depth + 1);
    return parent ? join(parent, basename(path)) : null;
  }
}

const MAX_COPY_TREE_ENTRIES = 4096;
const MAX_COPY_TREE_DEPTH = 64;

/** Bound observation cost and reject every alias cp -R could merge through below the target root. */
function recursiveTargetIsUnique(root) {
  const pending = [{ path: root, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    if (visited >= MAX_COPY_TREE_ENTRIES) return false;
    const current = pending.pop();
    const entry = copyTreeEntry(current.path, visited === 0, MAX_COPY_TREE_ENTRIES - visited - 1);
    if (entry?.missing) return true;
    if (!entry) return false;
    visited += 1;
    if (current.depth >= MAX_COPY_TREE_DEPTH && entry.children.length > 0) return false;
    for (const child of entry.children) pending.push({ path: join(current.path, child), depth: current.depth + 1 });
  }
  return true;
}

function copyTreeEntry(path, allowMissing, childLimit) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    return allowMissing && error.code === 'ENOENT' ? { children: [], missing: true } : null;
  }
  if (metadata.isSymbolicLink()) return null;
  if (metadata.isFile()) return metadata.nlink === 1 ? { children: [] } : null;
  if (!metadata.isDirectory()) return null;
  try {
    return { children: boundedDirectoryChildren(path, childLimit) };
  } catch {
    return null;
  }
}

function boundedDirectoryChildren(path, limit) {
  const directory = opendirSync(path);
  const children = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (children.length >= limit) throw new Error('copy tree entry limit exceeded');
      children.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return children;
}

function isConstrainedFfprobeRead(tokens) {
  return (
    tokens.length === 8 &&
    tokens[1] === '-v' &&
    tokens[2] === 'error' &&
    tokens[3] === '-show_entries' &&
    tokens[4] === 'format=duration,size' &&
    tokens[5] === '-of' &&
    tokens[6] === 'json' &&
    isAbsoluteSingleFilePath(tokens[7])
  );
}

function isAbsoluteSingleFilePath(raw) {
  return isAbsolute(raw) && isLiteralSinglePath(raw);
}

function isLiteralSinglePath(raw) {
  if (!raw || raw === '/' || raw.endsWith('/')) return false;
  if (/[*?[\]{}$`~\0\r\n]/.test(raw)) return false;
  return raw.split('/').every((segment) => !['.', '..'].includes(segment));
}

function firstEnvCommand(tokens) {
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index] === '-u' && tokens[index + 1]) {
      index += 2;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || tokens[index].startsWith('-')) {
      index += 1;
      continue;
    }
    return tokens[index];
  }
  return undefined;
}
