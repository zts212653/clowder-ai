import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGY_NATIVE_FILE_TOOLS } from './agy-native-policy.js';

export interface AgyNativeAgentFileInput {
  readonly profileHome: string;
  readonly catId: string;
  readonly systemPrompt: string;
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** AGY treats an indented or fenced `# comment` as an H1 and splits the native prompt. */
function markdownFenceKind(line: string): '`' | '~' | null {
  const prefix = line.trimStart().slice(0, 3);
  if (prefix === '```') return '`';
  if (prefix === '~~~') return '~';
  return null;
}

function assertL0SafeForAgyMarkdown(body: string): void {
  let fence: '`' | '~' | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = markdownFenceKind(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence && /^\s*#\s/.test(line)) throw new Error('AGY L0 code fence contains a false heading');
    if (/^ {4,}#\s/.test(line)) throw new Error('AGY L0 indented code contains a false heading');
  }
}

function ensureIsolatedDirectory(path: string): void {
  const stat = lstatIfPresent(path);
  if (stat?.isSymbolicLink()) throw new Error(`AGY native profile path must not be a symlink: ${path}`);
  if (stat && !stat.isDirectory()) throw new Error(`AGY native profile path must be a directory: ${path}`);
  if (!stat) mkdirSync(path, { mode: 0o700 });
}

/** Write one immutable agent file. A changed L0 gets a new agent name and must start a new CLI session. */
export function materializeAgyNativeAgentFile(input: AgyNativeAgentFileInput): {
  readonly agentName: string;
  readonly filePath: string;
  readonly l0Hash: string;
} {
  const suppliedHome = resolve(input.profileHome);
  if (lstatSync(suppliedHome).isSymbolicLink()) throw new Error('AGY native profile HOME must not be a symlink');
  const home = realpathSync(suppliedHome);
  if (home === realpathSync(homedir())) {
    throw new Error('AGY native agent requires an isolated profile, not the real user HOME');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(input.catId)) throw new Error('Unsafe AGY native cat ID');
  if (!input.systemPrompt.trim()) throw new Error('AGY native L0 must not be empty');
  assertL0SafeForAgyMarkdown(input.systemPrompt);

  const l0Hash = createHash('sha256').update(input.systemPrompt).digest('hex');
  const agentName = `cat-cafe-${input.catId}-${l0Hash.slice(0, 16)}`;
  let dir = home;
  for (const segment of ['.gemini', 'config', 'agents', agentName]) {
    dir = join(dir, segment);
    ensureIsolatedDirectory(dir);
  }
  const filePath = join(dir, 'agent.md');
  const markdown = [
    '---',
    `name: ${agentName}`,
    'description: Clowder AI native identity',
    'mainAgent: true',
    'subagent: false',
    'commandExecutionPolicy: off',
    'inheritMcp: true',
    'tools:',
    ...AGY_NATIVE_FILE_TOOLS.map((tool) => `  - ${tool}`),
    '---',
    input.systemPrompt,
  ].join('\n');
  const existing = lstatIfPresent(filePath);
  if (existing) {
    if (!existing.isFile() || readFileSync(filePath, 'utf8') !== markdown) {
      throw new Error('AGY native agent file was altered after materialization');
    }
  } else {
    writeFileSync(filePath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return { agentName, filePath, l0Hash };
}
