const HOUR = 60 * 60;

// 6379=default / 6099=fork runtime sanctuary / 6398=worktree dev /
// 6399=runtime sanctuary / 6401=user-redis persistent data.
const PROTECTED_REDIS_PORTS = new Set([6379, 6099, 6398, 6399, 6401]);
const CAT_CAFE_WORKTREE_PATH = /\/cat-cafe(?:-[^/\s]+)?(?:\/|$)/;

function tokenizeCommand(command) {
  return command.trim().split(/\s+/);
}

function execBasename(token) {
  if (!token) return '';
  const index = token.lastIndexOf('/');
  return index >= 0 ? token.slice(index + 1) : token;
}

function isNodeCommand(command) {
  const [executable = ''] = tokenizeCommand(command);
  return execBasename(executable) === 'node';
}

export function isCatCafeCommand(command) {
  return CAT_CAFE_WORKTREE_PATH.test(command);
}

function isPinchtabBinaryBasename(name) {
  return /^pinchtab(?:-[a-z]+(?:-[a-z0-9]+)?)?$/.test(name);
}

export function matchAgentBrowserMcpWrapper(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2) return false;
  const [executable, ...rest] = tokens;
  const executableBase = execBasename(executable);
  if (executableBase === 'npm' && rest[0] === 'exec' && rest[1] === 'agent-browser-mcp') return true;
  return executableBase === 'node' && rest.length >= 1 && execBasename(rest[0]) === 'agent-browser-mcp';
}

export function matchPlaywrightMcpWrapper(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2) return false;
  const [executable, ...rest] = tokens;
  const executableBase = execBasename(executable);
  if (executableBase === 'npm' && rest[0] === 'exec' && /^@playwright\/mcp(?:@\S+)?$/.test(rest[1] ?? '')) {
    return true;
  }
  return executableBase === 'node' && rest.length >= 1 && execBasename(rest[0]) === 'playwright-mcp';
}

export function matchPinchtabMcpWrapper(command) {
  const tokens = tokenizeCommand(command);
  if (tokens.length < 1) return false;
  const [executable, ...rest] = tokens;
  const executableBase = execBasename(executable);
  if (executableBase === 'pinchtab-mcp') return true;
  if (executableBase === 'npx' && rest[0] === 'pinchtab-mcp') return true;
  if (executableBase === 'npm' && rest[0] === 'exec' && rest[1] === 'pinchtab-mcp') return true;
  return isPinchtabBinaryBasename(executableBase) && executableBase !== 'pinchtab-mcp' && rest[0] === 'mcp';
}

export const STALE_DEV_PROCESS_RULES = [
  {
    id: 'orphan-isolated-redis',
    minAgeSeconds: 10 * 60,
    match: (processRow) => {
      if (processRow.ppid !== 1) return false;
      const match = processRow.command.match(/(?:^|\/)redis-server\s+\S*:(\d{2,5})\b/);
      return Boolean(match && !PROTECTED_REDIS_PORTS.has(Number(match[1])));
    },
    reason: 'orphaned unmanaged isolated Redis (reparented to init, non-sanctuary port)',
  },
  {
    id: 'cat-cafe-node-test-watch',
    minAgeSeconds: HOUR,
    match: (processRow) =>
      processRow.ppid === 1 &&
      processRow.command.includes('--test-timeout=0') &&
      /test\/cli-spawn-[\w-]+\.test\.js/.test(processRow.command),
    reason: 'orphaned Node test/watch process',
  },
  {
    id: 'orphan-cat-cafe-node-test',
    minAgeSeconds: HOUR,
    match: (processRow) =>
      processRow.ppid === 1 &&
      isNodeCommand(processRow.command) &&
      /(?:^|\s)--test(?:\s|=)/.test(processRow.command) &&
      isCatCafeCommand(processRow.command),
    reason: 'orphaned Clowder AI Node test runner (reparented to init)',
  },
  {
    id: 'orphan-cat-cafe-gate-permit',
    minAgeSeconds: HOUR,
    match: (processRow) =>
      processRow.ppid === 1 &&
      isNodeCommand(processRow.command) &&
      /\/scripts\/run-with-gate-resource-permit\.mjs(?:\s|$)/.test(processRow.command) &&
      isCatCafeCommand(processRow.command),
    reason: 'orphaned Clowder AI gate resource permit runner (reparented to init)',
  },
  {
    id: 'agent-browser-cli',
    minAgeSeconds: HOUR,
    match: (processRow) => processRow.ppid === 1 && /\/agent-browser(?:-[\w]+)*$/.test(processRow.command.trim()),
    reason: 'orphaned agent-browser CLI',
  },
  {
    id: 'catcafe-test-tmux',
    minAgeSeconds: HOUR,
    match: (processRow) => processRow.ppid === 1 && /tmux\b.*\bcatcafe-test-agent-spawn-/.test(processRow.command),
    reason: 'orphaned Clowder AI test tmux session',
  },
  {
    id: 'orphan-alpha-start',
    minAgeSeconds: 12 * HOUR,
    match: (processRow) => processRow.ppid === 1 && /\bpnpm\b.*\balpha:start\b/.test(processRow.command),
    reason: 'orphaned alpha:start process',
  },
  {
    id: 'stale-agent-browser-mcp-wrapper',
    minAgeSeconds: 8 * HOUR,
    match: (processRow) => matchAgentBrowserMcpWrapper(processRow.command),
    reason: 'stale agent-browser-mcp wrapper (>8h, unused MCP server lifetime)',
  },
  {
    id: 'stale-playwright-mcp-wrapper',
    minAgeSeconds: 8 * HOUR,
    match: (processRow) => matchPlaywrightMcpWrapper(processRow.command),
    reason: 'stale @playwright/mcp wrapper (>8h)',
  },
  {
    id: 'stale-pinchtab-mcp-wrapper',
    minAgeSeconds: 8 * HOUR,
    match: (processRow) => matchPinchtabMcpWrapper(processRow.command),
    reason: 'stale pinchtab-mcp wrapper (>8h)',
  },
];
