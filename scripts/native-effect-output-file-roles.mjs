import { findOutputAnalysis } from './native-effect-find-classifier.mjs';
import { stableArgumentWord } from './native-effect-shell-tokenizer.mjs';

const UNIQ_VALUES = new Set(['--skip-fields', '--skip-chars', '--check-chars']);
const UNIQ_FLAGS = new Set(['--count', '--repeated', '--unique', '--ignore-case', '--zero-terminated']);

/** File roles are argv semantics, never an executor or namespace certificate. */
export function outputFileAnalysis(name, words, syntaxComplete = true) {
  if (name === 'find') return findOutputAnalysis(words, syntaxComplete);
  if (name === 'uniq') return uniqOutputAnalysis(words, syntaxComplete);
  if (name !== 'git') return null;
  return gitOutputAnalysis(words, syntaxComplete);
}

function gitOutputAnalysis(words, syntaxComplete) {
  const boundary = words.findIndex((word) => word.literal && word.value === '--');
  const options = boundary < 0 ? words : words.slice(0, boundary);
  // Git value options can consume --; output detection never trusts it as a boundary.
  const outputs = words.flatMap((word, index) => gitOutputOption(word, words[index + 1]));
  const complete = (syntaxComplete || boundary >= 0) && options.every(stableArgumentWord);
  if (outputs.length)
    return result(
      'write',
      outputs.filter((value) => value !== null),
      complete && !outputs.includes(null) ? words.map((word) => word.value) : null,
    );
  // This is an output veto, not a grant of new Git read eligibility.
  return complete ? null : result('unknown', [], null);
}

function gitOutputOption(word, following) {
  if (!word.literal) return [];
  if (word.value === '--output') return [following?.literal ? following.value : null];
  return word.value.startsWith('--output=') ? [word.value.slice('--output='.length)] : [];
}

function uniqOutputAnalysis(words, syntaxComplete) {
  if (!syntaxComplete || words.some((word) => !word.literal)) return result('unknown', [], null);
  const operands = uniqOperands(words);
  if (!operands) {
    // Unrecognized BSD/GNU option spelling must not select the wrong output slot.
    const candidates = words.filter((word) => word.value !== '-').map((word) => word.value);
    return result(candidates.length ? 'write' : 'unknown', candidates, candidates);
  }
  const writes = operands.length > 1 && operands[1] !== '-' ? [operands[1]] : [];
  return result(writes.length ? 'write' : operands.length > 2 ? 'unknown' : 'read', writes, operands);
}

function uniqOperands(words) {
  const operands = [];
  let options = true;
  for (let index = 0; index < words.length; index++) {
    const token = words[index].value;
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (options && /^[+-]\d+$/.test(token)) continue; // BSD legacy skip-count options.
    if (!options || !token.startsWith('-') || token === '-') {
      operands.push(token);
      continue;
    }
    const role = uniqOption(token);
    if (!role) return null;
    if (role.value && !role.attached && !words[++index]) return null;
  }
  return operands;
}

function uniqOption(token) {
  if (token.startsWith('--')) {
    const [flag] = token.split('=', 1);
    if (UNIQ_VALUES.has(flag)) return { value: true, attached: token.includes('=') };
    if (UNIQ_FLAGS.has(token) || ['--all-repeated', '--group'].includes(flag)) return {};
    return null;
  }
  for (let index = 1; index < token.length; index++) {
    if ('fsw'.includes(token[index])) return { value: true, attached: index + 1 < token.length };
    if (!'cduiDz'.includes(token[index])) return null;
  }
  return {};
}

function result(effect, writes, paths) {
  return { handled: true, effect, writes, paths };
}
