/** `/dev/null` and fd duplication are sinks, not mutations of the command's cwd. */
export function stripHarmlessRedirections(raw) {
  return raw.replace(/(?:^|\s)(?:\d*>{1,2}\s*\/dev\/null|\d*>\s*&\s*\d+)(?=\s|$)/g, ' ');
}

export function tokenizeSimpleShellCommand(raw) {
  if (/`|\$\(|[<>]\(/.test(raw)) return null;
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g;
  const tokens = [];
  let cursor = 0;
  for (const match of raw.matchAll(tokenPattern)) {
    if (raw.slice(cursor, match.index).trim()) return null;
    tokens.push(decodeShellToken(match));
    cursor = (match.index ?? 0) + match[0].length;
  }
  return raw.slice(cursor).trim() ? null : tokens;
}

function decodeShellToken(match) {
  if (match[2] !== undefined) return match[2];
  return (match[1] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
}

export function commandName(raw) {
  return raw?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
}
