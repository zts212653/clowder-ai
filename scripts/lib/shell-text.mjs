/**
 * F300 -- scanning shell text: where things start, end, and what is a word.
 *
 * This layer knows nothing about killers, deployments or effects. It answers
 * only the lexical questions -- where one command line ends, where a pipeline
 * stage ends, and which parts of a stage are executed content -- so the layer
 * above can reason about invocations without re-deriving any of it.
 */

/** Stands in for a command substitution once its contents have been read. */
export const SUBSTITUTION = 'catcafe_substitution';

export function unquote(value) {
  return value?.replace(/^(['"])(.*)\1$/, '$2');
}

/** Quote-aware scan that cuts on the given single-character separators. */
function splitOutsideQuotes(raw, cut) {
  const parts = [];
  let current = '';
  let quote;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quote) {
      current += char;
      if (char === quote && raw[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const consumed = cut(raw, index);
    if (consumed > 0) {
      parts.push(current);
      current = '';
      index += consumed - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Split a raw string into the command lines it would run.
 *
 * The unit of judgment is one command line, not the whole string: in
 * `kill -0 9999; pkill -f "node api"` the halves have different answers.
 */
export function splitCommandLines(raw) {
  return splitOutsideQuotes(raw, (text, index) => {
    const pair = text.slice(index, index + 2);
    if (pair === '&&' || pair === '||') return 2;
    const char = text[index];
    return char === ';' || char === '\n' || char === '&' ? 1 : 0;
  });
}

/** Split one command line into its pipeline stages. */
export function splitPipelineStages(line) {
  return splitOutsideQuotes(line, (text, index) =>
    text[index] === '|' && text[index + 1] !== '|' && text[index - 1] !== '|' ? 1 : 0,
  );
}

/**
 * Pull command substitutions out of a stage, leaving a placeholder behind.
 *
 * `$(...)` and backticks run their contents, so the contents are executed
 * content and get read as such. Single quotes suppress substitution, so text
 * inside them is left alone.
 */
export function extractSubstitutions(stage) {
  const inner = [];
  let text = '';
  let quote;
  for (let index = 0; index < stage.length; index++) {
    const char = stage[index];
    if (quote) {
      text += char;
      if (char === quote && stage[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      text += char;
      continue;
    }
    if (char === '$' && stage[index + 1] === '(') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < stage.length && depth > 0) {
        if (stage[cursor] === '(') depth += 1;
        else if (stage[cursor] === ')') depth -= 1;
        if (depth > 0) cursor += 1;
      }
      if (depth !== 0) return { text: `${text}${stage.slice(index)}`, inner, readable: false };
      inner.push(stage.slice(index + 2, cursor));
      text += SUBSTITUTION;
      index = cursor;
      continue;
    }
    if (char === '`') {
      const end = stage.indexOf('`', index + 1);
      if (end < 0) return { text: `${text}${stage.slice(index)}`, inner, readable: false };
      inner.push(stage.slice(index + 1, end));
      text += SUBSTITUTION;
      index = end;
      continue;
    }
    text += char;
  }
  return { text, inner, readable: true };
}
