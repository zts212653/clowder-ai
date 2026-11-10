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
  if (index + 2 > tokens.length || !tokens[index] || tokens[index].startsWith('-')) return false;
  if (!readonly && !readonlyUri(tokens[index])) return false;
  return tokens.slice(index + 1).every(readonlyQuery);
}

function readonlyQuery(query) {
  if (!/[\r\n]/.test(query) && /^\.(?:schema|tables|indices|indexes)(?:[ \t]+[\w.*?%-]+)?[ \t]*$/i.test(query))
    return true;
  const syntax = sqlSyntax(query);
  if (syntax === null) return false;
  const statements = syntax.split(';').map((statement) => statement.trim());
  if (!statements.at(-1)) statements.pop();
  return statements.length > 0 && statements.every(readonlyStatement);
}

function readonlyUri(database) {
  if (!database.startsWith('file:') || !database.includes('?')) return false;
  const params = new URLSearchParams(database.slice(database.indexOf('?') + 1));
  return params.getAll('mode').length === 1 && params.get('mode') === 'ro';
}

function readonlyStatement(statement) {
  if (
    /^pragma\s+(?:(?:main|temp)\s*\.\s*)?(?:table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list)\s*\(\s*[\w.]+\s*\)$/i.test(
      statement,
    )
  )
    return true;
  return (
    /^(?:select\b|with\b|explain\s+query\s+plan\s+select\b)/i.test(statement) &&
    !/\b(?:insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|analyze|pragma|writefile|load_extension|eval)\b/i.test(
      statement,
    ) &&
    !/\b(?:edit|fts3_tokenizer)\s*\(/i.test(statement)
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
