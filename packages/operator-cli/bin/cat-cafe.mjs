#!/usr/bin/env node

const usage = `Usage:
  cat-cafe whoami
  cat-cafe threads list
  cat-cafe cats list
  cat-cafe messages list --thread <id> [--limit <1-10000>]
  cat-cafe messages send --thread <id> --text <text> [--mention <cat-id>]

Environment: CAT_CAFE_BASE_URL, CAT_CAFE_USER or CAT_CAFE_SESSION_COOKIE
Output: JSON on stdout; errors on stderr. See the package README for details.`;

class CliError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const fail = (message) => { throw new CliError(message, 2); };

function parse(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  let command;
  if (args[0] === 'whoami') command = 'whoami';
  else if (['threads', 'cats'].includes(args[0]) && args[1] === 'list') command = `${args[0]} list`;
  else if (args[0] === 'messages' && ['list', 'send'].includes(args[1])) command = `messages ${args[1]}`;
  else fail('Unknown command. Use --help for usage.');
  const rest = args.slice(command === 'whoami' ? 1 : 2);
  const allowed = command === 'messages send' ? ['thread', 'text', 'mention'] : command === 'messages list' ? ['thread', 'limit'] : [];
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(options, name) || i + 1 >= rest.length || rest[i + 1].startsWith('--')) fail(`Invalid option: ${rest[i]}`);
    options[name] = rest[++i];
  }
  if (command.startsWith('messages ') && !options.thread?.trim()) fail('--thread is required');
  if (command === 'messages send' && !options.text?.trim()) fail('--text is required');
  if (options.mention !== undefined && !options.mention.trim()) fail('--mention must not be empty');
  if (options.limit !== undefined && (!/^[0-9]+$/.test(options.limit) || Number(options.limit) < 1 || Number(options.limit) > 10000)) fail('--limit must be an integer from 1 to 10000');
  return { command, options };
}

async function main() {
  const { command, options, help } = parse(process.argv.slice(2));
  if (help) { process.stdout.write(`${usage}\n`); return; }
  let url;
  try { url = new URL(process.env.CAT_CAFE_BASE_URL || 'http://127.0.0.1:3004'); } catch { fail('Invalid CAT_CAFE_BASE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) fail('CAT_CAFE_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  const base = url.origin;
  const user = process.env.CAT_CAFE_USER?.trim();
  const cookie = process.env.CAT_CAFE_SESSION_COOKIE?.trim();
  if (!user && !cookie) fail('Set CAT_CAFE_USER or CAT_CAFE_SESSION_COOKIE');
  const headers = { accept: 'application/json' };
  if (user) headers['x-cat-cafe-user'] = user;
  if (cookie) headers.cookie = cookie;
  async function request(path, method = 'GET', body) {
    let response;
    try { response = await fetch(base + path, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
    catch { throw new CliError('Could not reach Host API', 4); }
    if (!response.ok) throw new CliError(`Host API returned HTTP ${response.status}`, 3);
    let data;
    try { data = await response.json(); } catch { throw new CliError('Host API returned invalid JSON', 4); }
    return { response, data };
  }
  let sessionUser;
  if (cookie) {
    const { response, data } = await request('/api/session');
    if (response.headers.has('set-cookie') || typeof data?.userId !== 'string' || !data.userId.trim()) throw new CliError('Session cookie was not accepted by Host', 3);
    sessionUser = data.userId;
  }
  let path, method = 'GET', body;
  if (command === 'whoami') path = '/api/cats';
  else if (command === 'threads list') path = '/api/threads';
  else if (command === 'cats list') path = '/api/cats';
  else if (command === 'messages list') {
    const query = new URLSearchParams({ threadId: options.thread });
    if (options.limit) query.set('limit', options.limit);
    path = `/api/messages?${query}`;
  } else {
    path = '/api/messages'; method = 'POST'; headers['content-type'] = 'application/json';
    body = JSON.stringify({ threadId: options.thread, content: options.text, ...(options.mention ? { mentions: [options.mention] } : {}) });
  }
  let data = command === 'whoami' && cookie ? null : (await request(path, method, body)).data;
  if (command === 'whoami') {
    data = { baseUrl: base, userId: cookie ? sessionUser : user, identitySource: cookie ? 'session' : 'header', verified: Boolean(cookie) };
  }
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof CliError ? error.message : 'Unexpected CLI error'}\n`); process.exitCode = error instanceof CliError ? error.code : 4; });
