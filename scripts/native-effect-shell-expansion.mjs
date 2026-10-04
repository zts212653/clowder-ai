import { homedir } from 'node:os';
import { shellWords } from './native-effect-shell-tokenizer.mjs';

/**
 * What a shell word can expand to under a path's bindings (moved out of
 * native-effect-segment-locations.mjs for slice 2b, where operands are expanded too).
 */

/** Binding marker: this path's assignments were dropped, so no variable on it can be read. */
export const FORGOTTEN = '\0forgotten';

/** Stands in for a substitution's output: a word, but never a readable path or name. */
export const OPAQUE = '\u0000opaque';

const MAX_EXPANSIONS = 16;

/** Pure bindings run no program. Substitutions/redirections are deliberately not admitted. */
export function isShellBinding(text) {
  const words = shellWords(text)?.map((word) => word.value);
  if (!words?.length) return false;
  if (words[0] === 'for' && /^[A-Za-z_]\w*$/.test(words[1] ?? '') && words[2] === 'in') return true;
  const assignments = words[0] === 'export' ? words.slice(1) : words;
  return assignments.length > 0 && assignments.every((word) => /^[A-Za-z_]\w*=/.test(word));
}

/**
 * Expand known bindings for target attribution, without evaluating or rescanning inserted text.
 * `argvPreserved` is separate: quoting a resolved value for this view must not certify that
 * an originally unquoted variable would remain one argument in the executing shell.
 */
export function expandSegmentBindings(text, bindings, env = process.env) {
  let variants = [{ text: '', argvPreserved: true }];
  let quote;
  const append = (part) => {
    variants = variants.map((variant) => ({ ...variant, text: variant.text + part }));
  };
  for (let index = 0; index < text.length; ) {
    const char = text[index];
    if (char === '\\' && quote !== "'") {
      append(text.slice(index, index + 2));
      index += 2;
      continue;
    }
    quote = nextQuote(quote, char);
    const variable = quote !== "'" && text.slice(index).match(/^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)/);
    if (!variable) {
      append(char);
      index += 1;
      continue;
    }
    const values = expandAll(variable[0], bindings, env);
    if (values) {
      variants = appendBindingViews(variants, values, quote, bindings, env);
      if (variants.length > MAX_EXPANSIONS) return [{ text, argvPreserved: false }];
    } else append(variable[0]);
    index += variable[0].length;
  }
  return variants;
}

function nextQuote(quote, char) {
  if (char === quote) return undefined;
  return !quote && (char === "'" || char === '"') ? char : quote;
}

function appendBindingViews(variants, values, quote, bindings, env) {
  return variants.flatMap((prefix) =>
    values.map((value) => ({
      text: prefix.text + bindingTargetText(value, quote, bindings, env),
      argvPreserved: prefix.argvPreserved && bindingPreservesArgv(value, quote, bindings, env),
    })),
  );
}

function bindingPreservesArgv(value, quote, bindings, env) {
  if (quote === '"') return true;
  // Parameter results undergo splitting/globbing, not a second pass of comment,
  // brace or tilde lexing. Literal #/~ in a bound value keep their data role.
  if (!value || /[*?[]/.test(value)) return false;
  const separators = bindingSeparators(bindings, env);
  return Array.isArray(separators) && separators.every((ifs) => ![...ifs].some((char) => value.includes(char)));
}

function bindingTargetText(value, quote, bindings, env) {
  if (quote === '"') return quoteValue(value, quote);
  const separators = bindingSeparators(bindings, env);
  if (!Array.isArray(separators)) return quoteValue(value);
  // This is target evidence, not an argv certificate: retain every possible split field,
  // escaped separately so text from a variable can never become shell syntax in our view.
  const fields = [''];
  const possible = new Set(separators.join(''));
  for (const char of value) {
    if (possible.has(char)) fields.push('');
    else fields[fields.length - 1] += char;
  }
  return fields.map((field) => quoteValue(field)).join(' ');
}

function bindingSeparators(bindings, env) {
  if (bindings.has('IFS')) return bindings.get('IFS');
  if (bindings.has(FORGOTTEN)) return null;
  return [env.IFS ?? ' \t\n'];
}

function quoteValue(value, quote) {
  if (quote === '"') return value.replace(/[\\"$`]/g, '\\$&');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Every value a word can take; undefined when any part cannot be read. A binding of null means "set, unreadable". */
export function expandAll(word, bindings, env) {
  if (word.includes(OPAQUE) || /[`*?[{]|\$\(/.test(word.replace(/\$\{[A-Za-z_]\w*\}/g, ''))) return undefined;
  let results = [word === '~' || word.startsWith('~/') ? `${homedir()}${word.slice(1)}` : word];
  for (let guard = 0; guard < 8 && results.some((text) => VARIABLE.test(text)); guard += 1) {
    const next = results.flatMap((text) => expandFirstVariable(text, bindings, env) ?? [null]);
    if (next.includes(null) || next.length > MAX_EXPANSIONS) return undefined;
    results = next;
  }
  return results.some((text) => text.includes('$')) ? undefined : results;
}

const VARIABLE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/;

/** `text` with its first variable replaced by each value it can hold; null when unreadable. */
function expandFirstVariable(text, bindings, env) {
  const match = text.match(VARIABLE);
  if (!match) return [text];
  const values = variableValues(match[1] ?? match[2], bindings, env);
  return values ? values.map((value) => text.replace(match[0], value)) : null;
}

function variableValues(name, bindings, env) {
  if (bindings.has(name)) return bindings.get(name);
  if (bindings.has(FORGOTTEN)) return null;
  if (name === 'HOME') return [homedir()];
  return env[name] !== undefined ? [env[name]] : null;
}
