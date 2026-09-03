import type { ManagedCommandActivity } from '@cat-cafe/shared';

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PRE_MERGE_SCRIPT_PATTERN = /(?:^|\/)pre-merge-check\.(?:sh|bash)$/u;
const PNPM_ACTIVITIES: ReadonlyArray<[ManagedCommandActivity, string]> = [
  ['full_gate', 'gate'],
  ['test', 'test'],
  ['build', 'build'],
  ['lint', 'lint'],
  ['check', 'check'],
];
const ACTIVITY_PRIORITY: readonly ManagedCommandActivity[] = ['full_gate', 'test', 'build', 'lint', 'check'];

function shellSegments(command: string): string[] {
  return (command.match(/(?:'[^']*'|"[^"]*"|[^;&|])+/gu) ?? []).map((segment) => segment.trim()).filter(Boolean);
}

function shellTokens(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []).map((token) => {
    const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"));
    return quoted ? token.slice(1, -1) : token;
  });
}

function basename(command: string): string {
  return command.split('/').at(-1) ?? command;
}

function nextEnvPrefixIndex(tokens: readonly string[], index: number): number | null {
  const token = tokens[index];
  if (token === undefined) return null;
  if (ASSIGNMENT_PATTERN.test(token) || token.startsWith('--unset=')) return index + 1;
  if (token === '-u' || token === '--unset') return index + 2;
  if (token === '--') return index + 1;
  if (token.startsWith('-')) return index + 1;
  return null;
}

function executableTokens(tokens: readonly string[]): string[] {
  let index = 0;
  while (ASSIGNMENT_PATTERN.test(tokens[index] ?? '')) index += 1;
  if (basename(tokens[index] ?? '') !== 'env') return tokens.slice(index);

  index += 1;
  let nextIndex = nextEnvPrefixIndex(tokens, index);
  while (nextIndex !== null) {
    index = nextIndex;
    nextIndex = nextEnvPrefixIndex(tokens, index);
  }
  return tokens.slice(index);
}

function isPnpmScript(tokens: readonly string[], script: string): boolean {
  return tokens.slice(1).some((token) => token === script || token.startsWith(`${script}:`));
}

function classifyShell(tokens: readonly string[]): ManagedCommandActivity | null {
  const commandFlagIndex = tokens.findIndex((token, index) => index > 0 && /^-[^-]*c/u.test(token));
  if (commandFlagIndex >= 0 && tokens[commandFlagIndex + 1] !== undefined) {
    return classifyManagedCommandActivity(tokens[commandFlagIndex + 1]);
  }
  const script = tokens.slice(1).find((token) => !token.startsWith('-'));
  return script !== undefined && PRE_MERGE_SCRIPT_PATTERN.test(script) ? 'full_gate' : null;
}

function classifyPnpm(tokens: readonly string[]): ManagedCommandActivity | null {
  return PNPM_ACTIVITIES.find(([, script]) => isPnpmScript(tokens, script))?.[0] ?? null;
}

function classifySegment(segment: string): ManagedCommandActivity | null {
  const tokens = executableTokens(shellTokens(segment));
  const executable = basename(tokens[0] ?? '');
  if (['bash', 'sh', 'zsh'].includes(executable)) return classifyShell(tokens);
  if (PRE_MERGE_SCRIPT_PATTERN.test(tokens[0] ?? '')) return 'full_gate';
  if (executable === 'node' && tokens.slice(1).includes('--test')) return 'test';
  return executable === 'pnpm' ? classifyPnpm(tokens) : null;
}

/** Reduce a private shell command to a small, non-sensitive activity category. */
export function classifyManagedCommandActivity(command: string): ManagedCommandActivity {
  const activities = shellSegments(command).map(classifySegment);
  return ACTIVITY_PRIORITY.find((activity) => activities.includes(activity)) ?? 'command';
}
