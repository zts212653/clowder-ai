import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentDefaults } from '@cat-cafe/shared';
import { type FrozenL0Input, renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { stringify } from 'yaml';
import { AGY_NATIVE_READ_TOOLS, AGY_NATIVE_TOOLS, deduplicateAgyNativeFileTools } from './agy-native-tools.js';

export interface AgyNativeAgentFileInput {
  readonly profileHome: string;
  readonly catId: string;
  readonly systemPrompt: string;
  readonly frozenL0Input?: FrozenL0Input;
  readonly autoApprove?: boolean;
  readonly tools?: readonly string[];
}

function stripVolatileL0Sections(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(
      /^## 主人画像\n[\s\S]*?(?=^\*\*硬限制\*\*|^你不是一个孤立的工具|^（无其他可用队友）$|^---$|^#{1,6} |$(?![\r\n]))/m,
      '\n\n',
    )
    .replace(/^(?:关系轨迹|共享事实): cat-cafe-profile:\/\/[^\n]*\n?/gm, '')
    .replace(/^读源走本轮绑定的 [^\n]+ 连接；勿用独立 App 的同名工具替代。\n?/gm, '')
    .replace(/^## 队友名册\n[\s\S]*?(?=^---$|^#{1,6} |$(?![\r\n]))/m, '\n\n')
    .replace(/^（无其他可用队友）\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatVolatileCapsuleBlock(rawCapsule: string): string {
  const trimmed = rawCapsule.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('## 主人画像') ? trimmed : `## 主人画像\n\n${trimmed}`;
}

function formatVolatileRosterBlock(rawRoster: string): string {
  const trimmed = rawRoster.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('## 队友名册') ? trimmed : `## 队友名册\n${trimmed}`;
}

function extractVolatileL0SectionsFromMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const capsuleSectionMatch = normalized.match(
    /^## 主人画像\n[\s\S]*?(?=^\*\*硬限制\*\*|^你不是一个孤立的工具|^（无其他可用队友）$|^---$|^#{1,6} |$(?![\r\n]))/m,
  );
  let capsuleBlock = '';
  if (capsuleSectionMatch) {
    capsuleBlock = capsuleSectionMatch[0].trim();
  } else {
    const pointerLines = normalized.match(
      /^(?:(?:关系轨迹|共享事实): cat-cafe-profile:\/\/[^\n]*|读源走本轮绑定的 [^\n]+ 连接；勿用独立 App 的同名工具替代。)$/gm,
    );
    if (pointerLines && pointerLines.length > 0) {
      capsuleBlock = formatVolatileCapsuleBlock(pointerLines.join('\n'));
    }
  }

  const rosterSectionMatch = normalized.match(/^## 队友名册\n[\s\S]*?(?=^---$|^#{1,6} |$(?![\r\n]))/m);
  let rosterBlock = '';
  if (rosterSectionMatch) {
    rosterBlock = rosterSectionMatch[0].trim();
  } else if (/^（无其他可用队友）$/m.test(normalized)) {
    rosterBlock = '## 队友名册\n（无其他可用队友）';
  }

  return [capsuleBlock, rosterBlock].filter(Boolean).join('\n\n');
}

/**
 * F325: Extract the per-turn volatile L0 sections (`USER_CAPSULE` and `TEAMMATE_ROSTER`)
 * excluded from the session-frozen `agent.md` so `--conversation` hot resumes receive
 * fresh capsule/roster updates on every turn.
 */
export function extractVolatileAgyNativeL0Context(systemPrompt: string, frozenL0Input?: FrozenL0Input): string {
  if (frozenL0Input && renderFrozenL0Input(frozenL0Input) === systemPrompt) {
    const capsuleVar = Object.hasOwn(frozenL0Input.variables, 'USER_CAPSULE')
      ? (frozenL0Input.variables.USER_CAPSULE ?? '')
      : '';
    const rosterVar = Object.hasOwn(frozenL0Input.variables, 'TEAMMATE_ROSTER')
      ? (frozenL0Input.variables.TEAMMATE_ROSTER ?? '')
      : '';
    const capsuleBlock = formatVolatileCapsuleBlock(capsuleVar);
    const rosterBlock = formatVolatileRosterBlock(rosterVar);
    return [capsuleBlock, rosterBlock].filter(Boolean).join('\n\n');
  }
  return extractVolatileL0SectionsFromMarkdown(systemPrompt);
}

/**
 * F325: AGY CLI freezes `agent.md` inside `trajectory_metadata_blob` on Turn 1,
 * so own-identity / restriction / house-governance edits MUST rotate `l0Hash`
 * (matching F274 `kimi-l0-session-fingerprint.ts`), whereas teammate roster and
 * owner capsule churn must NOT seal active sessions across the cafe.
 */
export function canonicalAgyNativeBindingBody(systemPrompt: string, frozenL0Input?: FrozenL0Input): string {
  if (frozenL0Input && renderFrozenL0Input(frozenL0Input) === systemPrompt) {
    const strippedVariables = {
      ...frozenL0Input.variables,
      ...(Object.hasOwn(frozenL0Input.variables, 'USER_CAPSULE') ? { USER_CAPSULE: '' } : {}),
      ...(Object.hasOwn(frozenL0Input.variables, 'TEAMMATE_ROSTER') ? { TEAMMATE_ROSTER: '' } : {}),
    };
    return renderFrozenL0Input({ ...frozenL0Input, variables: strippedVariables })
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return stripVolatileL0Sections(systemPrompt);
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

function writeImmutableAgentFile(filePath: string, agentName: string, markdown: string): void {
  const existing = lstatIfPresent(filePath);
  if (!existing) {
    writeFileSync(filePath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return;
  }
  if (!existing.isFile()) {
    throw new Error('AGY native agent file was altered after materialization');
  }
  const existingContent = readFileSync(filePath, 'utf8');
  if (!existingContent.startsWith(`---\nname: ${agentName}\n`)) {
    throw new Error('AGY native agent file was altered after materialization');
  }
  if (existingContent !== markdown) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tempPath, filePath);
  }
}

/** Write one immutable agent file. A changed L0 gets a new agent name and must start a new CLI session. */
export function materializeAgyNativeAgentFile(input: AgyNativeAgentFileInput): {
  readonly agentName: string;
  readonly filePath: string;
  readonly l0Hash: string;
  readonly volatileL0Context: string;
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

  const bindingBody = canonicalAgyNativeBindingBody(input.systemPrompt, input.frozenL0Input);
  if (!bindingBody) throw new Error('AGY native binding L0 must not be empty');
  const volatileL0Context = extractVolatileAgyNativeL0Context(input.systemPrompt, input.frozenL0Input);
  const l0Hash = createHash('sha256').update(bindingBody).digest('hex');
  const autoApprove = input.autoApprove === true;
  // CLI 1.5 resolves legacy names to modern names and rejects duplicate capabilities.
  const defaultTools = autoApprove ? AGY_NATIVE_TOOLS : AGY_NATIVE_READ_TOOLS;
  const tools = deduplicateAgyNativeFileTools(input.tools ?? defaultTools);
  const toolHash = input.tools
    ? `-${createHash('sha256').update(input.tools.join('\n')).digest('hex').slice(0, 8)}`
    : '';
  const agentName = `cat-cafe-${input.catId}-${l0Hash.slice(0, 16)}${autoApprove ? '-auto' : ''}${toolHash}`;
  let dir = home;
  for (const segment of ['.gemini', 'config', 'agents', agentName]) {
    dir = join(dir, segment);
    ensureIsolatedDirectory(dir);
  }
  const filePath = join(dir, 'agent.md');
  const markdown = [
    '---',
    `name: ${agentName}`,
    stringify({ description: `${deploymentDefaults.brand.displayName} native identity` }, { lineWidth: 0 }).trimEnd(),
    'mainAgent: true',
    'subagent: false',
    ...(autoApprove || input.tools?.includes('run_command') ? [] : ['commandExecutionPolicy: off']),
    'inheritMcp: true',
    ...(tools.length === 0 ? ['tools: []'] : ['tools:', ...tools.map((tool) => `  - ${tool}`)]),
    '---',
    `${bindingBody}\n`,
  ].join('\n');
  writeImmutableAgentFile(filePath, agentName, markdown);
  return { agentName, filePath, l0Hash, volatileL0Context };
}
