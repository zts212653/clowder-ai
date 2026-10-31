import { commandName, tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';

/** The CLI's readonly DB mode does not constrain extension functions or dot-command outputs. */
export function isConstrainedSqliteRead(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || commandName(tokens[0]) !== 'sqlite3') return false;
  let index = 1;
  let readonly = false;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    if (option === '-readonly') readonly = true;
    else if (!['-batch', '-noheader', '-header', '-json', '-csv', '-list', '-line'].includes(option)) return false;
    index += 1;
  }
  if (!readonly || index + 2 !== tokens.length || !tokens[index] || tokens[index].startsWith('-')) return false;
  const syntax = sqlSyntax(tokens[index + 1]);
  if (syntax === null || !/^(?:select\b|with\b|explain\s+query\s+plan\s+select\b)/i.test(syntax.trim())) return false;
  if (!/^[^;]*;?\s*$/.test(syntax)) return false;
  return (
    !/\b(?:insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|analyze|pragma|writefile|load_extension|eval)\b/i.test(
      syntax,
    ) && !/\b(?:edit|fts3_tokenizer)\s*\(/i.test(syntax)
  );
}

/** Strip SQL literals/comments, retain quoted identifiers, and reject unfinished lexical constructs. */
function sqlSyntax(query) {
  let syntax = '';
  for (let index = 0; index < query.length; ) {
    if (query.startsWith('--', index)) {
      const end = query.indexOf('\n', index + 2);
      index = end < 0 ? query.length : end + 1;
      syntax += ' ';
    } else if (query.startsWith('/*', index)) {
      const end = query.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 2;
      syntax += ' ';
    } else if (["'", '"', '`', '['].includes(query[index])) {
      const open = query[index++];
      const close = open === '[' ? ']' : open;
      let content = '',
        ended = false;
      while (index < query.length) {
        const char = query[index++];
        if (char !== close) content += char;
        else if (open !== '[' && query[index] === close) {
          content += close;
          index += 1;
        } else {
          ended = true;
          break;
        }
      }
      if (!ended) return null;
      syntax += open === "'" ? ' literal ' : ` ${content} `;
    } else syntax += query[index++];
  }
  return syntax;
}

export function isUnconstrainedSqliteOperation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  return Boolean(tokens && commandName(tokens[0]) === 'sqlite3' && !isConstrainedSqliteRead(raw));
}
