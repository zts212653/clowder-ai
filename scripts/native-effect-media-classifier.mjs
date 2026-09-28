import { isAbsolute } from 'node:path';

import {
  commandName,
  stripHarmlessRedirections,
  tokenizeSimpleShellCommand,
} from './native-effect-shell-tokenizer.mjs';

const MEDIA_OBSERVATION_COMMANDS = new Set(['ffprobe', 'shasum']);

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
  if (tokens[0] === 'shasum') return isConstrainedSha256Read(tokens);
  return false;
}

/** Attribute an exact single-file copy to the destination rather than its protected read source. */
export function explicitSingleFileCopyTarget(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || tokens.length !== 4 || tokens[0] !== 'cp' || tokens[1] !== '--') return null;
  const [source, destination] = tokens.slice(2);
  return isAbsoluteSingleFilePath(source) && isAbsoluteSingleFilePath(destination) ? destination : null;
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

function isConstrainedSha256Read(tokens) {
  return tokens.length === 4 && tokens[1] === '-a' && tokens[2] === '256' && isAbsoluteSingleFilePath(tokens[3]);
}

function isAbsoluteSingleFilePath(raw) {
  if (!isAbsolute(raw) || raw === '/' || raw.endsWith('/')) return false;
  if (/[*?[\]{}\0\r\n]/.test(raw)) return false;
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
