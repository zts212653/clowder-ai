import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentDefaults } from '@cat-cafe/shared';
import type { FrozenL0Input } from '@cat-cafe/shared/l0-input';
import { stringify } from 'yaml';
import { AGY_NATIVE_READ_TOOLS, AGY_NATIVE_TOOLS, deduplicateAgyNativeFileTools } from './agy-native-tools.js';
import { materializeAgyNativeL0Rules } from './launch/agy-native-l0-rules.js';
import { hostAgyNativeAgentName } from './launch/agy-session-compatibility.js';

export interface AgyNativeAgentFileInput {
  readonly profileHome: string;
  readonly catId: string;
  readonly systemPrompt: string;
  readonly frozenL0Input?: FrozenL0Input;
  readonly autoApprove?: boolean;
  readonly readOnly?: boolean;
  readonly scopedMember?: boolean;
  readonly tools?: readonly string[];
}

export function canonicalAgyNativeBindingBody(systemPrompt: string, _frozenL0Input?: FrozenL0Input): string {
  return systemPrompt
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** AGY treats an indented or fenced `# comment` inside agent.md as an H1 and splits the native prompt. */
function markdownFenceKind(line: string): '`' | '~' | null {
  const prefix = line.trimStart().slice(0, 3);
  if (prefix === '```') return '`';
  if (prefix === '~~~') return '~';
  return null;
}

function assertL0SafeForAgyAgentMarkdown(body: string): void {
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

function writeAgentFile(filePath: string, agentName: string, markdown: string): void {
  const existing = lstatIfPresent(filePath);
  if (!existing) {
    writeFileSync(filePath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return;
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
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

function buildHostSourceContractBody(catId: string): string {
  return [
    `# ${deploymentDefaults.brand.displayName} Native Host Contract (${catId})`,
    '',
    `This conversation belongs to ${deploymentDefaults.brand.displayName} member \`${catId}\`.`,
    'Live member identity, nickname, persona, role boundaries, house governance, owner capsule, teammate roster, and capability guidance are compiled and refreshed on every turn via the host-owned `cat-cafe-l0-*` rules in `<user_rules>` and supersede any mutable text from earlier turns.',
    'Tool, workspace, secret, and sanctuary boundaries are enforced per turn by the host runtime.',
  ].join('\n');
}

/**
 * Materialize a stable host agent contract plus per-turn `always_on` L0 rules.
 * `agent.md` stays immutable across config/nickname/governance/model updates so Turn 1
 * never freezes mutable rules; `cat-cafe-l0-*.md` refreshes full canonical L0 in
 * `systemInstruction` on every turn (including resumed legacy sessions).
 */
export function materializeAgyNativeAgentFile(input: AgyNativeAgentFileInput): {
  readonly agentName: string;
  readonly filePath: string;
  readonly rulePaths: readonly string[];
  readonly nativeInstructionBody: string;
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
  const canonicalBody = canonicalAgyNativeBindingBody(input.systemPrompt, input.frozenL0Input);
  if (!canonicalBody) throw new Error('AGY native L0 must not be empty');

  const l0Hash = createHash('sha256').update(canonicalBody).digest('hex');
  const autoApprove = input.autoApprove === true;
  const defaultTools = autoApprove ? AGY_NATIVE_TOOLS : AGY_NATIVE_READ_TOOLS;
  const tools = deduplicateAgyNativeFileTools(input.tools ?? defaultTools);
  const mode = input.scopedMember ? 'member' : input.readOnly ? 'readonly' : 'normal';
  const agentName = hostAgyNativeAgentName(input.catId, mode);

  let dir = home;
  for (const segment of ['.gemini', 'config', 'agents', agentName]) {
    dir = join(dir, segment);
    ensureIsolatedDirectory(dir);
  }
  const filePath = join(dir, 'agent.md');

  let agentBody: string;
  let rulePaths: readonly string[] = [];
  let renderedRules = '';
  if (input.scopedMember) {
    assertL0SafeForAgyAgentMarkdown(input.systemPrompt);
    agentBody = `${canonicalBody}\n`;
  } else {
    agentBody = `${buildHostSourceContractBody(input.catId)}\n`;
    assertL0SafeForAgyAgentMarkdown(agentBody);
    const rules = materializeAgyNativeL0Rules({
      profileHome: home,
      catId: input.catId,
      systemPrompt: canonicalBody,
      readOnly: input.readOnly,
    });
    rulePaths = rules.rulePaths;
    renderedRules = rules.renderedRules;
  }

  const markdown = [
    '---',
    `name: ${agentName}`,
    stringify({ description: `${deploymentDefaults.brand.displayName} native identity` }, { lineWidth: 0 }).trimEnd(),
    'mainAgent: true',
    'subagent: false',
    ...(autoApprove || tools.includes('run_command') ? [] : ['commandExecutionPolicy: off']),
    'inheritMcp: true',
    ...(tools.length === 0 ? ['tools: []'] : ['tools:', ...tools.map((tool) => `  - ${tool}`)]),
    '---',
    agentBody,
  ].join('\n');
  writeAgentFile(filePath, agentName, markdown);
  const nativeInstructionBody = renderedRules ? `${markdown}\n${renderedRules}` : markdown;
  return {
    agentName,
    filePath,
    rulePaths,
    nativeInstructionBody,
    l0Hash,
    volatileL0Context: '',
  };
}
